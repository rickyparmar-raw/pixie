process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const helperRoute = require("./helperRoute");
const assignmentLifecycle = require("./assignmentLifecycle");

db.open(":memory:");

function prog(id, helpers = []) {
  db.saveProgram({ id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`] });
  for (const h of helpers) db.syncHelper({ programId: id, userId: h, source: "manual" });
}

function newTicket(programId, overrides = {}) {
  const id = db.createTicket({
    programId,
    channel: `C-${programId}`,
    threadTs: `t-${programId}-${Math.random().toString(36).slice(2)}`,
    requesterId: "U-req",
    question: "q",
    category: overrides.category || null,
  });
  return db.getTicket(id);
}

/* ------------------------------------------------------- pingFatigue ---- */

test("pingFatigue counts only offers targeting this helper, ignoring pool offers and other helpers", () => {
  prog("fatigue-a", ["U-A", "U-B"]);
  const ticket = newTicket("fatigue-a");
  assignmentLifecycle.recordOffer({ ticket, to: null, source: "queue" }); // pool offer — must not count
  assignmentLifecycle.recordOffer({ ticket, to: "U-A", source: "ping" });
  const ticket2 = newTicket("fatigue-a");
  assignmentLifecycle.recordOffer({ ticket: ticket2, to: "U-B", source: "ping" }); // a different helper

  const fatigue = helperRoute.pingFatigue("fatigue-a", "U-A");
  assert.equal(fatigue.count, 1);
  assert.ok(fatigue.lastPingAt !== null);

  const untouched = helperRoute.pingFatigue("fatigue-a", "U-nobody");
  assert.equal(untouched.count, 0);
  assert.equal(untouched.lastPingAt, null);
});

test("pingFatigue only counts offers within the trailing 24h window", () => {
  prog("fatigue-b", ["U-A"]);
  const ticket = newTicket("fatigue-b");
  const old = Date.now() - 30 * 60 * 60 * 1000; // 30h ago
  db.addTicketEvent({ ticketId: ticket.id, programId: "fatigue-b", eventType: "helper_assignment_offered", detail: { to: "U-A", source: "ping" } });
  // Backdate the row directly — the module has no clock injection, so this is
  // the only way to exercise the window boundary deterministically.
  db.handle().query("UPDATE ticket_events SET created_at = ? WHERE program_id = 'fatigue-b' AND event_type = 'helper_assignment_offered'").run(old);

  const fatigue = helperRoute.pingFatigue("fatigue-b", "U-A");
  assert.equal(fatigue.count, 0, "an offer outside the 24h window must not count toward fatigue");
});

/* --------------------------------------------------------- scoreHelper -- */

test("fatigue is a small penalty that can only break a near-tie, never outrank real category expertise", () => {
  const specialist = helperRoute.scoreHelper(
    { user_id: "U-specialist", role: "member" },
    { tag: "review", expertise: [{ tag: "review", solved_count: 5, reply_count: 0 }], load: 0, fatigue: { count: 5, lastPingAt: Date.now() } },
  );
  const allRounder = helperRoute.scoreHelper(
    { user_id: "U-allrounder", role: "member" },
    { tag: "review", expertise: [], load: 0, fatigue: { count: 0, lastPingAt: null } },
  );
  assert.ok(specialist.score > allRounder.score, "5 verified resolutions must still beat a fresh, unpinged all-rounder");
});

test("fatigue breaks a near-tie in favor of the less-recently/less-frequently pinged helper", () => {
  const fresh = helperRoute.scoreHelper(
    { user_id: "U-fresh", role: "member" },
    { tag: "review", expertise: [{ tag: "review", solved_count: 1, reply_count: 0 }], load: 0, fatigue: { count: 0, lastPingAt: null } },
  );
  const fatigued = helperRoute.scoreHelper(
    { user_id: "U-fatigued", role: "member" },
    { tag: "review", expertise: [{ tag: "review", solved_count: 1, reply_count: 0 }], load: 0, fatigue: { count: 3, lastPingAt: Date.now() - 5 * 60 * 1000 } },
  );
  assert.ok(fresh.score > fatigued.score, "the less-pinged helper must win an otherwise-equal comparison");
  assert.ok(fresh.score - fatigued.score < 2, "the fatigue gap must stay smaller than a single category-match point");
});

/* ------------------------------------------------------------ recommend -- */

test("recommend never returns an inactive or non-roster helper", () => {
  prog("fair-active", ["U-active"]);
  db.syncHelper({ programId: "fair-active", userId: "U-inactive", source: "manual" });
  db.removeHelper({ programId: "fair-active", userId: "U-inactive" });
  const ranked = helperRoute.recommend({ programId: "fair-active", limit: 10 });
  assert.ok(ranked.every((r) => r.userId !== "U-inactive"));
});

test("recommend prefers the less-recently-pinged helper between two similarly-qualified candidates", () => {
  prog("fair-tiebreak", ["U-quiet", "U-busy"]);
  helperRoute.recordResolution({ programId: "fair-tiebreak", userId: "U-quiet", category: "general_support" });
  helperRoute.recordResolution({ programId: "fair-tiebreak", userId: "U-busy", category: "general_support" });

  // U-busy has already absorbed several automated pings recently; U-quiet has not.
  const ticket = newTicket("fair-tiebreak");
  for (let i = 0; i < 3; i += 1) {
    const t = newTicket("fair-tiebreak");
    assignmentLifecycle.recordOffer({ ticket: t, to: "U-busy", source: "ping" });
  }

  const [top] = helperRoute.recommend({ programId: "fair-tiebreak", category: "general_support", limit: 2 });
  assert.equal(top.userId, "U-quiet");
});

test("recommend still lets a genuine specialist win even against a fatigued but broader all-rounder", () => {
  prog("fair-specialist", ["U-specialist", "U-allrounder"]);
  helperRoute.recordResolution({ programId: "fair-specialist", userId: "U-specialist", category: "hardware" });
  helperRoute.recordResolution({ programId: "fair-specialist", userId: "U-specialist", category: "hardware" });
  helperRoute.recordResolution({ programId: "fair-specialist", userId: "U-specialist", category: "hardware" });
  // The all-rounder has broad history but nothing in this category, and is
  // completely un-pinged (fatigue would otherwise favor them).
  helperRoute.recordResolution({ programId: "fair-specialist", userId: "U-allrounder", category: "general_support" });
  helperRoute.recordResolution({ programId: "fair-specialist", userId: "U-allrounder", category: "shop_orders" });

  const [top] = helperRoute.recommend({ programId: "fair-specialist", category: "hardware", limit: 2 });
  assert.equal(top.userId, "U-specialist");
});
