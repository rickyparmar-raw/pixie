process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const metrics = require("./ticketMetrics") as typeof import("./ticketMetrics");
const helperStats = require("./helperStats") as typeof import("./helperStats");
const supportAnalytics = require("./supportAnalytics") as typeof import("./supportAnalytics");
const dashboardApi = require("./web/dashboardApi") as unknown as {
  metricsOverview(...args: unknown[]): { resolved: number };
  ticketSearchScoped(...args: unknown[]): { total: number };
};
const api = require("./web/api") as unknown as {
  internalAnalytics(...args: unknown[]): { byStatus: { resolved: number } };
};

before(() => {
  db.close();
  db.open(":memory:");
  db.saveProgram({ id: "metrics-truth", name: "Metrics truth", helpChannel: "C-metrics", channels: ["C-metrics"] });
  programs.invalidate();
  for (const userId of ["U-answered", "U-assignee", "U-gone"]) db.syncHelper({ programId: "metrics-truth", userId });
  db.removeHelper({ programId: "metrics-truth", userId: "U-gone" });
});

function insertTicket({
  threadTs,
  status,
  createdAt,
  resolvedAt = null,
  assigneeId = null,
  resolvedBy = null,
  creditId = null,
}) {
  const row = db
    .handle()
    .query(
      `INSERT INTO tickets
      (program_id, channel, thread_ts, requester_id, question, status, assignee_id,
       category, created_at, updated_at, resolved_at, resolved_by, resolved_credit_id)
     VALUES ('metrics-truth', 'C-metrics', ?, 'U-asker', ?, ?, ?, 'support', ?, ?, ?, ?, ?)`,
    )
    .run(threadTs, threadTs, status, assigneeId, createdAt, createdAt, resolvedAt, resolvedBy, creditId);
  return Number(row.lastInsertRowid);
}

test("all metric surfaces use current resolved state, resolved_at windows, and stored historical credit", () => {
  const now = Date.now();
  const since = now - 30 * 86400000;
  const oldCreated = since - 86400000;
  const inWindow = now - 3600000;

  const answered = insertTicket({
    threadTs: "answered",
    status: "resolved",
    createdAt: inWindow,
    resolvedAt: inWindow + 10,
    creditId: "U-answered",
  });
  const assignee = insertTicket({
    threadTs: "assignee",
    status: "resolved",
    createdAt: inWindow,
    resolvedAt: inWindow + 20,
    assigneeId: "U-assignee",
  });
  const bounced = insertTicket({
    threadTs: "bounced",
    status: "resolved",
    createdAt: inWindow,
    resolvedAt: inWindow + 30,
    creditId: "U-assignee",
  });
  const gone = insertTicket({
    threadTs: "gone",
    status: "resolved",
    createdAt: inWindow,
    resolvedAt: inWindow + 40,
    creditId: "U-gone",
  });
  insertTicket({ threadTs: "closed", status: "closed", createdAt: inWindow, resolvedAt: inWindow + 50 });
  insertTicket({ threadTs: "auto", status: "resolved", createdAt: inWindow, resolvedAt: inWindow + 60 });
  insertTicket({ threadTs: "dashboard-only", status: "open", createdAt: inWindow });
  insertTicket({
    threadTs: "old-created",
    status: "resolved",
    createdAt: oldCreated,
    resolvedAt: inWindow + 70,
    creditId: "U-answered",
  });

  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'metrics-truth', 'U-answered', 'helper_reply', ?)",
    )
    .run(answered, inWindow - 10);
  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'metrics-truth', 'U-answered', 'helper_reply', ?)",
    )
    .run(bounced, inWindow - 9);
  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'metrics-truth', 'U-assignee', 'helper_reply', ?)",
    )
    .run(bounced, inWindow - 8);
  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'metrics-truth', 'U-gone', 'helper_reply', ?)",
    )
    .run(gone, inWindow - 7);
  db.handle().query("UPDATE tickets SET reopen_count = 1 WHERE id = ?").run(bounced);

  const totals = metrics.programTotals("metrics-truth", { since });
  assert.equal(totals.resolved, 5);
  assert.equal(totals.resolvedInWindow, 6);
  assert.equal(totals.closed, 1);

  const board = metrics.leaderboard("metrics-truth", { since });
  assert.deepEqual(Object.fromEntries(board.filter((row) => row.resolved).map((row) => [row.userId, row.resolved])), {
    "U-assignee": 2,
    "U-answered": 2,
    "U-gone": 1,
  });
  assert.equal(board.find((row) => row.userId === "U-assignee").reopened, 1);

  const overview = supportAnalytics.overview("metrics-truth", 30 * 86400000);
  assert.equal(overview.byStatus.resolved, totals.resolvedInWindow);
  assert.equal(
    overview.helperResolved.reduce((sum, row) => sum + row.resolved, 0),
    5,
  );
  assert.equal(dashboardApi.metricsOverview("metrics-truth", { days: 30 }).resolved, totals.resolvedInWindow);
  assert.equal(api.internalAnalytics("metrics-truth", { days: 30 }).byStatus.resolved, totals.resolvedInWindow);

  const helpers = helperStats.listHelperStats("metrics-truth", { since });
  assert.equal(helpers.find((row) => row.userId === "U-gone").totals.resolved, 1);
  assert.equal(
    helpers.reduce((sum, row) => sum + row.totals.resolved, 0),
    5,
  );
  assert.equal(dashboardApi.ticketSearchScoped("metrics-truth", { statusGroup: "resolved" }).total, 6);
  assert.equal(dashboardApi.ticketSearchScoped("metrics-truth", { status: "closed" }).total, 1);
});
export {};
import type { TestDb } from "./test.types";
