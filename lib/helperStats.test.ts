process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as typeof import("./db");
const { helperStats, listHelperStats, median, rate } = require("./helperStats");

db.open(":memory:");

function program(id: string, userId: string, active = 1): void {
  db.handle().query("INSERT INTO programs (id, name, scope, updated_at) VALUES (?, ?, 'program', ?)").run(id, id, Date.now());
  db.syncHelper({ programId: id, userId, role: "helper" });
  if (!active) db.removeHelper({ programId: id, userId });
}

function ticket(programId: string, assigneeId: string, createdAt: number, overrides: { status?: string; category?: string; assignedAt?: number; firstResponseAt?: number | null; resolvedAt?: number | null; resolvedBy?: string; reopenCount?: number } = {}): number {
  const result = db.handle().query(
    `INSERT INTO tickets (program_id, channel, thread_ts, requester_id, question, status, assignee_id, category, created_at, updated_at, assigned_at, first_human_response_at, resolved_at, resolved_by, reopen_count)
     VALUES (?, 'C', ?, 'requester', 'question', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(programId, `${programId}-${createdAt}-${Math.random()}`, overrides.status || "resolved", assigneeId, overrides.category || "support", createdAt, createdAt, overrides.assignedAt || createdAt, overrides.firstResponseAt || null, overrides.resolvedAt || null, overrides.resolvedBy || assigneeId, overrides.reopenCount || 0);
  return Number(result.lastInsertRowid);
}

test("median handles even and empty data deterministically", () => {
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([100, 300]), 200);
  assert.equal(median([]), null);
});

test("rate returns null when there is no denominator", () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(1, 4), 0.25);
});

test("helper stats are program-scoped and expose real lifecycle metrics", () => {
  program("stats-a", "U-A");
  program("stats-b", "U-A");
  const base = Date.now() - 100000;
  const first = ticket("stats-a", "U-A", base, { firstResponseAt: base + 1000, resolvedAt: base + 5000 });
  const reopened = ticket("stats-a", "U-A", base + 10000, { status: "reopened", firstResponseAt: base + 11000, reopenCount: 1 });
  ticket("stats-b", "U-A", base, { resolvedAt: base + 9000 });
  db.handle().query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, 'stats-a', 'U-A', 'helper_reply', ?, ?)").run(first, JSON.stringify({ ts: "reply-a" }), base + 1000);
  db.handle().query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'stats-a', 'U-A', 'resolved', ?)").run(first, base + 5000);
  db.handle().query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'stats-a', 'U-A', 'resolved', ?)").run(reopened, base + 15000);
  db.handle().query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'stats-a', 'requester', 'reopened', ?)").run(reopened, base + 20000);
  db.handle().query("INSERT INTO feedback (message_ts, user_id, vote, created_at) VALUES ('reply-a', 'requester', 1, ?)").run(base + 2000);
  db.handle().query("INSERT INTO feedback (message_ts, user_id, vote, created_at) VALUES ('other', 'requester', -1, ?)").run(base + 2000);
  db.handle().query("INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, updated_at) VALUES ('stats-a', 'U-A', 'support', 1, ?)").run(base);
  const stats = helperStats("stats-a", "U-A");
  assert.equal(stats.totals.resolved, 1);
  assert.equal(stats.totals.open, 1);
  assert.equal(stats.totals.reopened, 0);
  assert.equal(stats.reopenRate, 0);
  assert.equal(stats.medianFirstResponseMs, 1000);
  assert.equal(stats.medianResolutionMs, 5000);
  assert.equal(stats.helpfulPercentage, 1);
  assert.equal(stats.acceptRate, null);
  assert.equal(listHelperStats("stats-a").length, 1);
  assert.equal(listHelperStats("stats-a")[0].programId, "stats-a");
});

test("zero-data helpers and revoked helpers remain explicit", () => {
  program("empty", "U-EMPTY");
  program("revoked", "U-REVOKED", 0);
  const empty = helperStats("empty", "U-EMPTY");
  assert.equal(empty.totals.assigned, 0);
  assert.equal(empty.totals.resolved, 0);
  assert.equal(empty.helpfulPercentage, null);
  assert.equal(empty.lastActivity, null);
  assert.equal(listHelperStats("revoked").length, 1);
  assert.equal(listHelperStats("revoked")[0].active, false);
});
export {};
