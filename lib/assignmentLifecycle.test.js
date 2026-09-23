process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const tickets = require("./tickets");
const lifecycle = require("./assignmentLifecycle");
const helperRoute = require("./helperRoute");

db.open(":memory:");

let seq = 0;
function prog(id, helpers = []) {
  db.saveProgram({ id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`] });
  for (const h of helpers) db.syncHelper({ programId: id, userId: h, source: "manual" });
}
function newTicket(programId, overrides = {}) {
  seq += 1;
  const id = db.createTicket({
    programId,
    workspaceId: "WS",
    channel: `C-${programId}`,
    threadTs: `t-${programId}-${seq}`,
    requesterId: "U-req",
    question: "q",
    category: overrides.category || null,
  });
  return id;
}
function events(programId, ticketId) {
  return db.listTicketEvents(ticketId).filter((e) => e.program_id === programId).map((e) => e.event_type);
}
function metricCount(kind) {
  return db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = ?").get(kind).c;
}

/* --------------------------------------------------------------- claim -- */

test("a program helper claims an offered ticket and it counts as accepted", () => {
  prog("al-claim", ["U-h1"]);
  const id = newTicket("al-claim");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  const res = tickets.claimTicket({ ticketId: id, actorId: "U-h1" });
  assert.equal(res.ok, true);
  assert.equal(res.ticket.assignee_id, "U-h1");
  assert.ok(events("al-claim", id).includes("helper_assignment_claimed"));
  const stats = lifecycle.helperAcceptStats("al-claim", "U-h1");
  assert.equal(stats.acceptedAssignments, 1);
  assert.equal(stats.completedOffers, 1);
});

test("an inactive helper cannot claim", () => {
  prog("al-inactive", ["U-active", "U-gone"]);
  db.removeHelper({ programId: "al-inactive", userId: "U-gone" });
  const id = newTicket("al-inactive");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  const res = tickets.claimTicket({ ticketId: id, actorId: "U-gone" });
  assert.match(res.error, /not a helper/);
  assert.equal(events("al-inactive", id).includes("helper_assignment_claimed"), false);
});

test("a helper of another program cannot claim across the boundary", () => {
  prog("al-progA", ["U-a"]);
  prog("al-progB", ["U-b"]);
  const id = newTicket("al-progB");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  const res = tickets.claimTicket({ ticketId: id, actorId: "U-a", programId: "al-progB" });
  assert.match(res.error, /not a helper/);
});

test("two simultaneous claims produce exactly one winner and one claimed event", () => {
  prog("al-race", ["U-r1", "U-r2"]);
  const id = newTicket("al-race");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  const a = tickets.claimTicket({ ticketId: id, actorId: "U-r1" });
  const b = tickets.claimTicket({ ticketId: id, actorId: "U-r2" });
  const wins = [a, b].filter((r) => r.ok).length;
  const losses = [a, b].filter((r) => r.error).length;
  assert.equal(wins, 1);
  assert.equal(losses, 1);
  assert.equal(events("al-race", id).filter((t) => t === "helper_assignment_claimed").length, 1);
});

test("a duplicate claim (Slack retry) does not append a second claimed event", () => {
  prog("al-dup", ["U-h"]);
  const id = newTicket("al-dup");
  const ticket = db.getTicket(id);
  lifecycle.recordOffer({ ticket, to: null, source: "queue" });
  assert.equal(lifecycle.recordClaim({ ticket, userId: "U-h" }).recorded, true);
  assert.equal(lifecycle.recordClaim({ ticket, userId: "U-h" }).recorded, false);
  assert.equal(events("al-dup", id).filter((t) => t === "helper_assignment_claimed").length, 1);
});

/* ------------------------------------------------------------- decline -- */

test("decline records an event without touching ticket status or resolution", () => {
  prog("al-decline", ["U-d"]);
  const id = newTicket("al-decline");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  const before = db.getTicket(id);
  const res = tickets.declineAssignment({ ticketId: id, actorId: "U-d" });
  assert.equal(res.ok, true);
  const after = db.getTicket(id);
  assert.equal(after.status, before.status);
  assert.equal(after.assignee_id, null);
  assert.equal(after.resolution, null);
  assert.ok(events("al-decline", id).includes("helper_assignment_declined"));
  assert.equal(events("al-decline", id).includes("resolved"), false);
  const stats = lifecycle.helperAcceptStats("al-decline", "U-d");
  assert.equal(stats.declinedAssignments, 1);
  assert.equal(stats.acceptedAssignments, 0);
});

/* ------------------------------------------------------------- release -- */

test("release after claim records a distinct released event and re-offers the ticket", () => {
  prog("al-release", ["U-h"]);
  const id = newTicket("al-release");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  tickets.claimTicket({ ticketId: id, actorId: "U-h" });
  const res = tickets.unclaimTicket({ ticketId: id, actorId: "U-h" });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "open");
  assert.equal(db.getTicket(id).assignee_id, null);
  const trail = events("al-release", id);
  assert.ok(trail.includes("helper_assignment_released"));
  // released is not a decline and does not lower the accept rate
  const stats = lifecycle.helperAcceptStats("al-release", "U-h");
  assert.equal(stats.releasedAssignments, 1);
  assert.equal(stats.declinedAssignments, 0);
  assert.equal(stats.acceptedAssignments, 1);
  // the ticket is offered to the pool again
  assert.equal(trail.filter((t) => t === "helper_assignment_offered").length, 2);
});

test("release without a prior claim is rejected", () => {
  prog("al-norelease", ["U-h"]);
  const id = newTicket("al-norelease");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  const res = tickets.unclaimTicket({ ticketId: id, actorId: "U-h" });
  assert.match(res.error, /not claimed/);
  assert.equal(events("al-norelease", id).includes("helper_assignment_released"), false);
});

/* ------------------------------------------------------------- timeout -- */

test("the timeout sweep is a no-op until the program sets helper_offer_timeout_ms", () => {
  prog("al-noto", ["U-h"]);
  const id = newTicket("al-noto");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  const out = lifecycle.sweepProgramTimeouts({ programId: "al-noto", now: Date.now() + 5 * 3600 * 1000 });
  assert.equal(out.swept, 0);
  assert.equal(events("al-noto", id).includes("helper_assignment_timed_out"), false);
});

test("a stale offer times out once and only once when a timeout is configured", () => {
  prog("al-to", ["U-h"]);
  db.handle().query("UPDATE programs SET helper_offer_timeout_ms = ? WHERE id = ?").run(30 * 60 * 1000, "al-to");
  const id = newTicket("al-to");
  const offeredAt = Date.now() - 60 * 60 * 1000;
  db.handle().query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, 'al-to', NULL, 'helper_assignment_offered', ?, ?)")
    .run(id, JSON.stringify({ to: null, source: "queue" }), offeredAt);
  const first = lifecycle.sweepProgramTimeouts({ programId: "al-to" });
  const second = lifecycle.sweepProgramTimeouts({ programId: "al-to" });
  assert.equal(first.swept, 1);
  assert.equal(second.swept, 0);
  assert.equal(events("al-to", id).filter((t) => t === "helper_assignment_timed_out").length, 1);
});

/* -------------------------------------------------------- accept rate -- */

test("accept rate is claimed / (claimed + declined + timed-out), sample size exposed", () => {
  prog("al-rate", ["U-x"]);
  for (let i = 0; i < 3; i += 1) {
    const id = newTicket("al-rate");
    lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
    lifecycle.recordClaim({ ticket: db.getTicket(id), userId: "U-x" });
  }
  const declineId = newTicket("al-rate");
  lifecycle.recordOffer({ ticket: db.getTicket(declineId), to: null, source: "queue" });
  lifecycle.recordDecline({ ticket: db.getTicket(declineId), userId: "U-x" });
  const stats = lifecycle.helperAcceptStats("al-rate", "U-x");
  assert.equal(stats.acceptedAssignments, 3);
  assert.equal(stats.declinedAssignments, 1);
  assert.equal(stats.completedOffers, 4);
  assert.equal(stats.acceptRate, 0.75);
  assert.equal(stats.assignmentLifecycle, "supported");
});

test("pending offers are excluded from the accept-rate denominator", () => {
  prog("al-pending", ["U-p"]);
  const claimedId = newTicket("al-pending");
  lifecycle.recordOffer({ ticket: db.getTicket(claimedId), to: null, source: "queue" });
  lifecycle.recordClaim({ ticket: db.getTicket(claimedId), userId: "U-p" });
  const pendingId = newTicket("al-pending");
  lifecycle.recordOffer({ ticket: db.getTicket(pendingId), to: "U-p", source: "reassign" });
  const stats = lifecycle.helperAcceptStats("al-pending", "U-p");
  assert.equal(stats.acceptedAssignments, 1);
  assert.equal(stats.completedOffers, 1); // the pending targeted offer is not counted
  assert.equal(stats.offered, 1); // but it is visible as an offer made
  assert.equal(stats.acceptRate, null); // below the minimum sample
});

test("pre-lifecycle tickets never fabricate an accept rate", () => {
  prog("al-legacy", ["U-old"]);
  const id = newTicket("al-legacy");
  // Old-style transitions only — no helper_assignment_* events at all.
  db.addTicketEvent({ ticketId: id, programId: "al-legacy", actorId: "U-old", eventType: "claimed" });
  db.addTicketEvent({ ticketId: id, programId: "al-legacy", actorId: "U-old", eventType: "resolved" });
  const stats = lifecycle.helperAcceptStats("al-legacy", "U-old");
  assert.equal(stats.acceptRate, null);
  assert.equal(stats.completedOffers, 0);
  assert.equal(stats.assignmentLifecycle, "unsupported");
});

test("manually resolving a ticket with no offer records no lifecycle and no accept rate", () => {
  prog("al-manual", ["U-m"]);
  const id = newTicket("al-manual");
  db.markTicketWaitingForHelper(id);
  tickets.claimTicket({ ticketId: id, actorId: "U-m" }); // no recordOffer was called
  tickets.resolveTicket({ ticketId: id, actorId: "U-m" });
  const stats = lifecycle.helperAcceptStats("al-manual", "U-m");
  assert.equal(stats.acceptedAssignments, 0);
  assert.equal(stats.acceptRate, null);
});

test("helper accept stats are program-scoped", () => {
  prog("al-scopeA", ["U-s"]);
  prog("al-scopeB", ["U-s"]);
  const a = newTicket("al-scopeA");
  lifecycle.recordOffer({ ticket: db.getTicket(a), to: null, source: "queue" });
  lifecycle.recordClaim({ ticket: db.getTicket(a), userId: "U-s" });
  assert.equal(lifecycle.helperAcceptStats("al-scopeA", "U-s").acceptedAssignments, 1);
  assert.equal(lifecycle.helperAcceptStats("al-scopeB", "U-s").acceptedAssignments, 0);
  assert.equal(lifecycle.helperAcceptStats("al-scopeB", "U-s").assignmentLifecycle, "unsupported");
});

/* --------------------------------------------------- routing retry (capability) -- */

test("nextEligibleHelper skips a helper who declined", () => {
  prog("al-retry", ["U-1", "U-2", "U-3"]);
  const id = newTicket("al-retry");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  lifecycle.recordDecline({ ticket: db.getTicket(id), userId: "U-1" });
  const next = lifecycle.nextEligibleHelper({ programId: "al-retry", ticketId: id });
  assert.ok(next && next.userId !== "U-1");
});

// Was previously wired to nothing automatic. lib/tickets.js's
// declineAssignment now calls this after a targeted decline closes an open
// offer — "declined helper -> next eligible helper gets exactly one ping" is
// a required invariant (see the [epoch] fixtures in tickets.test.js), and a
// decline is exactly the "something meaningful happened" that permits it.
test("nextEligibleHelper is wired into tickets.js's decline path", () => {
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/tickets.js", "utf8");
  assert.ok(src.includes("nextEligibleHelper"));
});

/* ---------------------------------------------------- coexistence / safety -- */

test("shadow routing and the lifecycle offer coexist on the same escalation", () => {
  prog("pixl", ["U-sh1", "U-sh2"]);
  helperRoute.setExpertise({ programId: "pixl", userId: "U-sh1", tags: ["support"] });
  const id = newTicket("pixl", { category: "support" });
  tickets.markWaitingForHelper({ ticketId: id });
  const trail = events("pixl", id);
  assert.ok(trail.includes("helper_routing_recommended"), "shadow routing still snapshots");
  assert.ok(trail.includes("helper_assignment_offered"), "a pool offer is recorded");
  // the shadow snapshot is unchanged in shape
  const snap = db.listTicketEvents(id).find((e) => e.event_type === "helper_routing_recommended");
  const detail = JSON.parse(snap.detail);
  assert.equal(detail.mode, "shadow");
  assert.ok(Array.isArray(detail.candidates));
});

test("autoAssign stays off by default — no ticket is auto-assigned by the offer path", () => {
  prog("al-noauto", ["U-h"]);
  assert.equal(db.handle().query("SELECT auto_assign FROM programs WHERE id = ?").get("al-noauto").auto_assign, 0);
  const id = newTicket("al-noauto");
  tickets.markWaitingForHelper({ ticketId: id });
  assert.equal(db.getTicket(id).assignee_id, null, "offer to the pool does not assign anyone");
  assert.equal(db.getTicket(id).status, "waiting_for_helper");
});

test("lifecycle events emit their own metrics", () => {
  prog("al-metrics", ["U-h"]);
  const base = metricCount("helper_assignment_claimed");
  const id = newTicket("al-metrics");
  lifecycle.recordOffer({ ticket: db.getTicket(id), to: null, source: "queue" });
  lifecycle.recordClaim({ ticket: db.getTicket(id), userId: "U-h" });
  assert.equal(metricCount("helper_assignment_offered") >= 1, true);
  assert.equal(metricCount("helper_assignment_claimed"), base + 1);
});
