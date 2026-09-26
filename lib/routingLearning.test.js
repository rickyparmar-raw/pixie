process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const tickets = require("./tickets");
const helperRoute = require("./helperRoute");
const { helperStats } = require("./helperStats");

before(() => {
  db.close();
  db.open(":memory:");
});

function setup(id) {
  db.saveProgram({ id, name: id, posture: "active", helpChannel: `C-${id}`, channels: [`C-${id}`] });
  for (const userId of ["U-alice", "U-bob", "U-cara"]) {
    db.syncHelper({ programId: id, userId, source: "test", role: "helper" });
  }
  helperRoute.setExpertise({ programId: id, userId: "U-alice", tags: ["review"] });
  helperRoute.setExpertise({ programId: id, userId: "U-bob", tags: [] });
  helperRoute.setExpertise({ programId: id, userId: "U-cara", tags: ["hardware"] });
}

function createTicket(programId, suffix, category = "review") {
  const id = db.createTicket({
    programId,
    channel: `C-${programId}`,
    threadTs: `${programId}-${suffix}`,
    requesterId: "U-requester",
    question: `${category} question`,
    category,
  });
  return db.getTicket(id);
}

function resolve(ticket, actorId) {
  const result = actorId === "U-requester"
    ? tickets.publicResolveTicket({ ticketId: ticket.id, actorId })
    : tickets.resolveTicket({ ticketId: ticket.id, actorId, programId: ticket.program_id });
  assert.equal(result.ok, true);
  return db.getTicket(ticket.id);
}

test("assigned handoff credits the replying helper and changes recommendation", () => {
  const programId = "learn-handoff";
  setup(programId);
  const ticket = createTicket(programId, "handoff");
  assert.equal(db.assignTicket(ticket.id, "U-alice"), true);

  tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: ticket.thread_ts, userId: "U-bob" });
  const resolved = resolve(ticket, "U-bob");

  assert.equal(resolved.resolved_by, "U-bob");
  assert.equal(helperRoute.getExpertise(programId, "U-alice").find((row) => row.tag === "review").solved_count, 0);
  assert.equal(helperRoute.getExpertise(programId, "U-bob").find((row) => row.tag === "review").solved_count, 1);
  assert.equal(helperRoute.recommend({ programId, category: "review", limit: 1 })[0].userId, "U-bob");

  const bobStats = helperStats(programId, "U-bob");
  const aliceStats = helperStats(programId, "U-alice");
  assert.deepEqual(bobStats.categoryResolved, [{ category: "review", resolved: 1 }]);
  assert.equal(bobStats.totals.resolved, 1);
  assert.deepEqual(aliceStats.categoryResolved, []);
  assert.equal(aliceStats.totals.resolved, 0);
});

test("assigned ticket without a helper reply falls back to the assignee", () => {
  const programId = "learn-assignee-fallback";
  setup(programId);
  const ticket = createTicket(programId, "fallback");
  assert.equal(db.assignTicket(ticket.id, "U-alice"), true);

  resolve(ticket, "U-requester");

  assert.equal(helperRoute.getExpertise(programId, "U-alice").find((row) => row.tag === "review").solved_count, 1);
  assert.equal(helperRoute.getExpertise(programId, "U-bob").find((row) => row.tag === "review"), undefined);
  assert.equal(helperStats(programId, "U-alice").totals.resolved, 1);
  assert.equal(helperStats(programId, "U-bob").totals.resolved, 0);

  const requesterOnly = createTicket(programId, "requester-only");
  resolve(requesterOnly, "U-requester");
  assert.equal(helperRoute.getExpertise(programId, "U-requester").length, 0);
});

test("requester resolution after a helper reply credits the helper, not the requester", () => {
  const programId = "learn-requester-resolution";
  setup(programId);
  const ticket = createTicket(programId, "requester");
  assert.equal(db.assignTicket(ticket.id, "U-alice"), true);

  tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: ticket.thread_ts, userId: "U-bob" });
  const resolved = resolve(ticket, "U-requester");

  assert.equal(resolved.resolved_by, "U-requester");
  assert.equal(helperRoute.getExpertise(programId, "U-bob").find((row) => row.tag === "review").solved_count, 1);
  assert.equal(helperRoute.getExpertise(programId, "U-alice").find((row) => row.tag === "review").solved_count, 0);
  assert.equal(helperStats(programId, "U-bob").totals.resolved, 1);
});

test("multi-ticket learning shifts recommendations ticket by ticket", () => {
  const programId = "learn-sequence";
  setup(programId);

  const first = createTicket(programId, "sequence-review");
  assert.equal(helperRoute.recommend({ programId, category: "review", limit: 1 })[0].userId, "U-alice");
  tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: first.thread_ts, userId: "U-bob" });
  resolve(first, "U-bob");
  assert.equal(helperRoute.recommend({ programId, category: "review", limit: 1 })[0].userId, "U-bob");

  const second = createTicket(programId, "sequence-hardware", "hardware");
  assert.equal(helperRoute.recommend({ programId, category: "hardware", limit: 1 })[0].userId, "U-cara");
  tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: second.thread_ts, userId: "U-bob" });
  resolve(second, "U-bob");
  assert.equal(helperRoute.recommend({ programId, category: "hardware", limit: 1 })[0].userId, "U-bob");

  const bob = helperStats(programId, "U-bob");
  assert.deepEqual(bob.categoryResolved, [
    { category: "review", resolved: 1 },
    { category: "hardware", resolved: 1 },
  ]);
});
