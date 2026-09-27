type TestAny = any;
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const shadowRouting = require("./shadowRouting");
const tickets = require("./tickets");
const helperRoute = require("./helperRoute");

before(() => {
  db.close();
  db.open(":memory:");
  db.handle()
    .query("INSERT INTO programs (id, name, scope, updated_at) VALUES ('pixl', 'Pixl', 'program', ?)")
    .run(Date.now());
  db.handle()
    .query("INSERT INTO programs (id, name, scope, updated_at) VALUES ('other', 'Other', 'program', ?)")
    .run(Date.now());
  db.syncHelper({ programId: "pixl", userId: "U-REVIEW", role: "helper" });
  db.syncHelper({ programId: "pixl", userId: "U-GONE", role: "helper" });
  db.removeHelper({ programId: "pixl", userId: "U-GONE" });
  db.syncHelper({ programId: "other", userId: "U-OTHER", role: "helper" });
  helperRoute.setExpertise({ programId: "pixl", userId: "U-REVIEW", tags: ["review"] });
});

function addTicket(programId: TestAny, suffix: TestAny, category = "review") {
  const createdAt = Date.now();
  const result = db
    .handle()
    .query(
      `INSERT INTO tickets (program_id, channel, thread_ts, requester_id, question, category, status, created_at, updated_at)
     VALUES (?, 'C', ?, 'U-REQUESTER', 'question', ?, 'open', ?, ?)`,
    )
    .run(programId, suffix, category, createdAt, createdAt);
  return db.getTicket(Number(result.lastInsertRowid));
}

test("shadow snapshot stores the recommendation and is append-only", () => {
  const ticket = addTicket("pixl", "shadow-1");
  const first = shadowRouting.snapshotForTicket(ticket);
  assert.ok(first);
  assert.equal(first.detail.mode, "shadow");
  assert.equal(first.detail.candidates[0].userId, "U-REVIEW");
  helperRoute.setExpertise({ programId: "pixl", userId: "U-REVIEW", tags: ["support"] });
  assert.equal(shadowRouting.snapshotForTicket(db.getTicket(ticket.id)), null);
  const listed = shadowRouting.list("pixl", 10);
  assert.equal(listed[0].candidates[0].userId, "U-REVIEW");
  assert.equal(listed[0].candidates[0].expertiseMatches[0], "review");
});

test("shadow snapshots are program-scoped and exclude inactive helpers", () => {
  const ticket = addTicket("other", "shadow-2", "review");

  const snap = shadowRouting.snapshotForTicket(ticket);
  assert.ok(snap);
  assert.ok(snap.detail.candidates.length > 0);
  assert.ok(snap.detail.candidates.every((candidate: TestAny) => candidate.userId === "U-OTHER"));
  const pixl = shadowRouting.list("pixl", 10);
  assert.ok(pixl.every((row: TestAny) => row.programId === "pixl"));
  assert.ok(pixl[0].candidates.every((candidate: TestAny) => candidate.userId !== "U-GONE"));
});

test("autoAssign=false records shadow routing without assigning or pinging", () => {
  const ticket = addTicket("pixl", "shadow-3");
  const updated = tickets.markWaitingForHelper({ ticketId: ticket.id, program: { id: "pixl", autoAssign: false } });
  assert.equal(updated.assignee_id, null);
  assert.equal(updated.status, "waiting_for_helper");
  assert.ok(db.listTicketEvents(ticket.id).some((event: TestAny) => event.event_type === shadowRouting.EVENT_TYPE));
});
export {};
