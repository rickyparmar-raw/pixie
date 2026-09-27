process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const workspace = require("./workspace");
const routing = require("./routing");
const programs = require("./programs");

before(() => {
  db.close();
  db.open(":memory:");
});

test("workspaceOf prefers the event team id, then the configured one", () => {
  assert.equal(workspace.workspaceOf({ team: "T1", channel: "C1" }), "T1");
  assert.equal(workspace.workspaceOf({}, { team_id: "T2" }), "T2");
  assert.equal(workspace.workspaceOf({}), workspace.configuredWorkspaceId());
});

test("channel claims are atomic: second program loses, double claim wins", () => {
  const a = db.claimProgramChannel({ workspaceId: "T1", channelId: "C-help", programId: "highway", kind: "help" });
  assert.equal(a.ok, true);

  const conflict = db.claimProgramChannel({ workspaceId: "T1", channelId: "C-help", programId: "pixl", kind: "help" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ownerProgramId, "highway");

  // Same workspace+channel in another workspace is a different channel.
  const other = db.claimProgramChannel({ workspaceId: "T2", channelId: "C-help", programId: "pixl", kind: "help" });
  assert.equal(other.ok, true);

  // Double-submit Activate collapses onto the existing row.
  const retry = db.claimProgramChannel({ workspaceId: "T1", channelId: "C-help", programId: "highway", kind: "help" });
  assert.equal(retry.ok, true);
});

test("claimChannelsForProgram rolls back partial claims on conflict", () => {
  db.claimProgramChannel({ workspaceId: "T9", channelId: "C-taken", programId: "other", kind: "help" });
  const res = routing.claimChannelsForProgram({
    workspaceId: "T9",
    programId: "newprog",
    channels: [{ id: "C-free", kind: "help" }, { id: "C-taken", kind: "discussion" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.conflictChannel, "C-taken");
  assert.equal(db.getChannelOwner("T9", "C-free"), null);
});

test("forChannel resolves explicit claims before config lists", () => {
  programs.invalidate();
  db.saveProgram({ id: "hwy", name: "Highway", helpChannel: "C-hwy", channels: ["C-hwy"] });
  db.claimProgramChannel({ workspaceId: "TW", channelId: "C-hwy", programId: "hwy", kind: "help" });
  programs.invalidate();
  const prog = routing.resolveChannelProgram({ workspaceId: "TW", channelId: "C-hwy" });
  assert.equal(prog.id, "hwy");
  assert.equal(programs.isHelpChannel("C-hwy", "TW"), true);
});

// --- helperRoute characterization: pins exact current behavior ---------
const helperRoute = require("./helperRoute");

function charSetupProgram(id: any) {
  db.saveProgram({ id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`] });
  programs.invalidate();
}

function charTicket(programId: any, ts: any, assigneeId: string | null = null, status: string | null = null) {
  const tid = db.createTicket({
    programId,
    workspaceId: "T-char",
    channel: `C-${programId}`,
    threadTs: ts,
    requesterId: "U-req",
    question: "q",
  });
  if (status) {
    db.handle().query("UPDATE tickets SET status = ?, assignee_id = ? WHERE id = ?").run(status, assigneeId, tid);
  } else if (assigneeId) {
    db.assignTicket(tid, assigneeId);
  }
  return tid;
}

function charEvent({ programId, actorId, ageMs = 1000 }: Record<string, any>) {
  const tid = db.createTicket({
    programId,
    workspaceId: "T-char",
    channel: `C-${programId}`,
    threadTs: `ev-${programId}-${actorId}-${Math.random()}`,
    requesterId: "U-req",
    question: "q",
  });
  db.handle()
    .query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, 'note_added', NULL, ?)")
    .run(tid, programId, actorId, Date.now() - ageMs);
  return tid;
}

test("char: empty roster recommends nobody", () => {
  charSetupProgram("hr-char-empty");
  assert.deepEqual(helperRoute.recommend({ programId: "hr-char-empty", category: "pcb" }), []);
});

test("char: fresh helper scores base 1 with member+load reasons", () => {
  charSetupProgram("hr-char-base");
  db.syncHelper({ programId: "hr-char-base", userId: "U-base" });
  const [rec] = helperRoute.recommend({ programId: "hr-char-base" });
  assert.equal(rec.userId, "U-base");
  assert.equal(rec.score, 1);
  assert.equal(rec.load, 0);
  assert.ok(rec.reasons.includes("active program member"));
  assert.ok(rec.reasons.includes("no open assigned tickets"));
});

test("char: category match is 2+min(solved,10) plus min(total,5)*0.2", () => {
  charSetupProgram("hr-char-weights");
  db.syncHelper({ programId: "hr-char-weights", userId: "U-w" });
  helperRoute.setExpertise({ programId: "hr-char-weights", userId: "U-w", tags: ["ordering"] });
  helperRoute.recordResolution({ programId: "hr-char-weights", userId: "U-w", category: "ordering" });
  helperRoute.recordResolution({ programId: "hr-char-weights", userId: "U-w", category: "ordering" });
  // base 1 + (2+2) match + 2*0.2 total = 5.4
  const [rec] = helperRoute.recommend({ programId: "hr-char-weights", category: "ordering" });
  assert.equal(rec.score, 5.4);
  assert.ok(rec.reasons.some((r: any) => r.includes("2 verified ordering resolutions")));
  assert.ok(rec.reasons.some((r: any) => r.includes("2 total verified resolutions")));
});

test("char: solved caps at 10 and total caps at 5", () => {
  charSetupProgram("hr-char-caps");
  db.syncHelper({ programId: "hr-char-caps", userId: "U-cap" });
  helperRoute.setExpertise({ programId: "hr-char-caps", userId: "U-cap", tags: ["pcb", "other"] });
  for (let i = 0; i < 15; i++) helperRoute.recordResolution({ programId: "hr-char-caps", userId: "U-cap", category: "pcb" });
  for (let i = 0; i < 5; i++) helperRoute.recordResolution({ programId: "hr-char-caps", userId: "U-cap", category: "other" });
  // match pts cap: 2+10=12; total 20 caps to 5*0.2=1.0; base 1 => 14
  const [rec] = helperRoute.recommend({ programId: "hr-char-caps", category: "pcb" });
  assert.equal(rec.score, 14);
});

test("char: load penalty is min(load,5)*0.5 and caps at 2.5", () => {
  charSetupProgram("hr-char-load");
  db.syncHelper({ programId: "hr-char-load", userId: "U-busy" });
  db.syncHelper({ programId: "hr-char-load", userId: "U-free" });
  for (let i = 0; i < 2; i++) charTicket("hr-char-load", `hr-load-2-${i}`, "U-busy");
  const mid = helperRoute.recommend({ programId: "hr-char-load" });
  assert.equal(mid.find((r: any) => r.userId === "U-busy").score, 0);
  assert.equal(mid.find((r: any) => r.userId === "U-free").score, 1);
  for (let i = 2; i < 8; i++) charTicket("hr-char-load", `hr-load-2-${i}`, "U-busy");
  const capped = helperRoute.recommend({ programId: "hr-char-load" });
  assert.equal(capped.find((r: any) => r.userId === "U-busy").score, -1.5);
  assert.equal(capped.find((r: any) => r.userId === "U-busy").load, 8);
});

test("char: openLoad counts only claimed|assigned|waiting_for_helper|escalated|reopened", () => {
  charSetupProgram("hr-char-statuses");
  db.syncHelper({ programId: "hr-char-statuses", userId: "U-s" });
  const counted = ["claimed", "assigned", "waiting_for_helper", "escalated", "reopened"];
  const ignored = ["open", "ai_answered", "resolved", "closed", "duplicate", "snoozed", "spam"];
  counted.forEach((s, i) => charTicket("hr-char-statuses", `hr-counted-${s}`, "U-s", s));
  assert.equal(helperRoute.openLoad("hr-char-statuses", "U-s"), counted.length);
  ignored.forEach((s, i) => charTicket("hr-char-statuses", `hr-ignored-${s}`, "U-s", s));
  assert.equal(helperRoute.openLoad("hr-char-statuses", "U-s"), counted.length);
});

test("char: recent 7d activity adds 0.5, older does not", () => {
  charSetupProgram("hr-char-recent");
  db.syncHelper({ programId: "hr-char-recent", userId: "U-fresh" });
  db.syncHelper({ programId: "hr-char-recent", userId: "U-stale" });
  db.syncHelper({ programId: "hr-char-recent", userId: "U-never" });
  charEvent({ programId: "hr-char-recent", actorId: "U-fresh", ageMs: 1000 });
  charEvent({ programId: "hr-char-recent", actorId: "U-stale", ageMs: 8 * 24 * 60 * 60 * 1000 });
  const recs = helperRoute.recommend({ programId: "hr-char-recent" });
  assert.equal(recs.find((r: any) => r.userId === "U-fresh").score, 1.5);
  assert.equal(recs.find((r: any) => r.userId === "U-stale").score, 1);
  assert.equal(recs.find((r: any) => r.userId === "U-never").score, 1);
  assert.ok(recs.find((r: any) => r.userId === "U-fresh").reasons.includes("active in the last 7 days"));
});

test("char: organizer/owner add 0.5, inactive members never route", () => {
  charSetupProgram("hr-char-roles");
  db.syncHelper({ programId: "hr-char-roles", userId: "U-org", role: "organizer" });
  db.syncHelper({ programId: "hr-char-roles", userId: "U-own", role: "owner" });
  db.syncHelper({ programId: "hr-char-roles", userId: "U-help", role: "helper" });
  db.syncHelper({ programId: "hr-char-roles", userId: "U-gone", role: "helper" });
  db.removeHelper({ programId: "hr-char-roles", userId: "U-gone" });
  const recs = helperRoute.recommend({ programId: "hr-char-roles" });
  assert.equal(recs.find((r: any) => r.userId === "U-org").score, 1.5);
  assert.equal(recs.find((r: any) => r.userId === "U-own").score, 1.5);
  assert.equal(recs.find((r: any) => r.userId === "U-help").score, 1);
  assert.ok(!recs.some((r: any) => r.userId === "U-gone"));
  assert.ok(recs.find((r: any) => r.userId === "U-org").reasons.includes("program organizer"));
});

test("char: unknown category gives no match points; matching is case-insensitive", () => {
  charSetupProgram("hr-char-unknown");
  db.syncHelper({ programId: "hr-char-unknown", userId: "U-u" });
  helperRoute.setExpertise({ programId: "hr-char-unknown", userId: "U-u", tags: ["pcb"] });
  helperRoute.recordResolution({ programId: "hr-char-unknown", userId: "U-u", category: "pcb" });
  const unknown = helperRoute.recommend({ programId: "hr-char-unknown", category: "nope-xyz" })[0];
  // base 1 + total 1*0.2, no 2+solved match
  assert.equal(unknown.score, 1.2);
  assert.ok(!unknown.reasons.some((r: any) => r.includes("verified nope-xyz")));
  const upper = helperRoute.recommend({ programId: "hr-char-unknown", category: "PCB" })[0];
  assert.equal(upper.score, 4.2);
});

test("char: ties break by roster order (earliest added first)", () => {
  charSetupProgram("hr-char-tie");
  db.syncHelper({ programId: "hr-char-tie", userId: "U-first" });
  db.syncHelper({ programId: "hr-char-tie", userId: "U-second" });
  db.handle().query("UPDATE program_helpers SET added_at = ? WHERE program_id = ? AND user_id = ?").run(1000, "hr-char-tie", "U-first");
  db.handle().query("UPDATE program_helpers SET added_at = ? WHERE program_id = ? AND user_id = ?").run(2000, "hr-char-tie", "U-second");
  const recs = helperRoute.recommend({ programId: "hr-char-tie" });
  assert.equal(recs[0].userId, "U-first");
  assert.equal(recs[1].userId, "U-second");
});

test("char: limit clamps to [1,10]", () => {
  charSetupProgram("hr-char-limit");
  for (let i = 0; i < 4; i++) db.syncHelper({ programId: "hr-char-limit", userId: `U-lim-${i}` });
  assert.equal(helperRoute.recommend({ programId: "hr-char-limit", limit: 1 }).length, 1);
  assert.equal(helperRoute.recommend({ programId: "hr-char-limit", limit: 0 }).length, 1);
  assert.equal(helperRoute.recommend({ programId: "hr-char-limit", limit: 100 }).length, 4);
});

test("char: routing never leaks across programs", () => {
  charSetupProgram("hr-char-xa");
  charSetupProgram("hr-char-xb");
  db.syncHelper({ programId: "hr-char-xa", userId: "U-shared" });
  helperRoute.setExpertise({ programId: "hr-char-xa", userId: "U-shared", tags: ["pcb"] });
  helperRoute.recordResolution({ programId: "hr-char-xa", userId: "U-shared", category: "pcb" });
  for (let i = 0; i < 3; i++) charTicket("hr-char-xa", `hr-xa-${i}`, "U-shared");
  assert.deepEqual(helperRoute.recommend({ programId: "hr-char-xb", category: "pcb" }), []);
  db.syncHelper({ programId: "hr-char-xb", userId: "U-shared" });
  const [rec] = helperRoute.recommend({ programId: "hr-char-xb", category: "pcb" });
  // no expertise and no load leaked from xa: base score only
  assert.equal(rec.score, 1);
  assert.equal(rec.load, 0);
});

test("char: setExpertise normalizes tags and preserves solved_count", () => {
  charSetupProgram("hr-char-exp");
  db.syncHelper({ programId: "hr-char-exp", userId: "U-e" });
  const clean = helperRoute.setExpertise({ programId: "hr-char-exp", userId: "U-e", tags: [" PCB ", "pcb", "", "Firmware"] });
  assert.deepEqual(clean, ["pcb", "firmware"]);
  helperRoute.recordResolution({ programId: "hr-char-exp", userId: "U-e", category: "pcb" });
  helperRoute.setExpertise({ programId: "hr-char-exp", userId: "U-e", tags: ["pcb", "cad"] });
  const rows = helperRoute.getExpertise("hr-char-exp", "U-e");
  assert.equal(rows.find((r: any) => r.tag === "pcb").solved_count, 1);
  assert.equal(rows.find((r: any) => r.tag === "cad").solved_count, 0);
});

test("char: recordResolution defaults missing category to general", () => {
  charSetupProgram("hr-char-gen");
  db.syncHelper({ programId: "hr-char-gen", userId: "U-g" });
  helperRoute.recordResolution({ programId: "hr-char-gen", userId: "U-g" });
  const rows = helperRoute.getExpertise("hr-char-gen", "U-g");
  assert.equal(rows.find((r: any) => r.tag === "general").solved_count, 1);
});

test("char: scoreHelper is pure — pins weights without DB", () => {
  const now = 1_700_000_000_000;
  const base = helperRoute.scoreHelper({ user_id: "U-p", role: "helper" }, { now });
  assert.equal(base.score, 1);
  const full = helperRoute.scoreHelper(
    { user_id: "U-p", role: "organizer" },
    {
      tag: "pcb",
      expertise: [{ tag: "pcb", solved_count: 2 }],
      load: 2,
      lastActiveAt: now - 1000,
      now,
    },
  );
  // 1 + (2+2) match + 2*0.2 breadth - 2*0.5 load + 0.5 recent + 0.5 role = 5.4
  assert.equal(full.score, 5.4);
  assert.deepEqual(helperRoute.scoreHelper({ user_id: "U-p", role: "helper" }, { now }), base);
});

test("char: scoreHelper recency boundary is strictly < 7 days", () => {
  const now = 1_700_000_000_000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const justInside = helperRoute.scoreHelper({ user_id: "U-p", role: "helper" }, { lastActiveAt: now - (week - 1), now });
  const exactlyWeek = helperRoute.scoreHelper({ user_id: "U-p", role: "helper" }, { lastActiveAt: now - week, now });
  assert.equal(justInside.score, 1.5);
  assert.equal(exactlyWeek.score, 1);
});

test("char: replies add 0.2 each to the category match and cap at 15", () => {
  charSetupProgram("hr-char-replies");
  db.syncHelper({ programId: "hr-char-replies", userId: "U-chatty" });
  for (let i = 0; i < 5; i++) helperRoute.recordReply({ programId: "hr-char-replies", userId: "U-chatty", category: "reviews" });
  // base 1 + match (2 + 0 solved + 5*0.2) = 4. Breadth is resolutions-only, so
  // replies never inflate the cross-category bonus.
  const [rec] = helperRoute.recommend({ programId: "hr-char-replies", category: "reviews" });
  assert.equal(rec.score, 4);
  assert.ok(rec.reasons.some((r: any) => r.includes("5 reviews replies")));

  charSetupProgram("hr-char-replies-cap");
  db.syncHelper({ programId: "hr-char-replies-cap", userId: "U-flood" });
  for (let i = 0; i < 40; i++) helperRoute.recordReply({ programId: "hr-char-replies-cap", userId: "U-flood", category: "reviews" });
  // base 1 + 2 + min(40,15)*0.2 = 6
  assert.equal(helperRoute.recommend({ programId: "hr-char-replies-cap", category: "reviews" })[0].score, 6);
});

test("char: one resolution outranks a pile of replies in the same category", () => {
  charSetupProgram("hr-char-resolve-beats-reply");
  db.syncHelper({ programId: "hr-char-resolve-beats-reply", userId: "U-talker" });
  db.syncHelper({ programId: "hr-char-resolve-beats-reply", userId: "U-closer" });
  for (let i = 0; i < 4; i++) helperRoute.recordReply({ programId: "hr-char-resolve-beats-reply", userId: "U-talker", category: "reviews" });
  helperRoute.recordResolution({ programId: "hr-char-resolve-beats-reply", userId: "U-closer", category: "reviews" });

  const [first] = helperRoute.recommend({ programId: "hr-char-resolve-beats-reply", category: "reviews" });
  assert.equal(first.userId, "U-closer");
});

test("char: setExpertise keeps reply counts, and keeps tags a helper has real history in", () => {
  charSetupProgram("hr-char-keep");
  db.syncHelper({ programId: "hr-char-keep", userId: "U-k" });
  helperRoute.setExpertise({ programId: "hr-char-keep", userId: "U-k", tags: ["pcb", "stale"] });
  helperRoute.recordResolution({ programId: "hr-char-keep", userId: "U-k", category: "pcb" });
  helperRoute.recordReply({ programId: "hr-char-keep", userId: "U-k", category: "pcb" });
  helperRoute.recordReply({ programId: "hr-char-keep", userId: "U-k", category: "firmware" });

  // Re-declaring drops "stale" (nothing observed) but must not erase the
  // firmware history just because nobody declared it.
  helperRoute.setExpertise({ programId: "hr-char-keep", userId: "U-k", tags: ["pcb", "cad"] });
  const rows = helperRoute.getExpertise("hr-char-keep", "U-k");
  const byTag = new Map<string, any>(rows.map((r: any) => [r.tag, r]));

  assert.equal(byTag.get("pcb").solved_count, 1);
  assert.equal(byTag.get("pcb").reply_count, 1);
  assert.equal(byTag.get("cad").solved_count, 0);
  assert.equal(byTag.get("firmware").reply_count, 1, "observed history survives a re-declaration");
  assert.equal(byTag.has("stale"), false, "an undeclared tag with no history is dropped");
});
export {};
