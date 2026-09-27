process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const tickets = require("./tickets");
const analytics = require("./supportAnalytics");

const DAY = 86400000;
const HOUR = 3600000;
const WINDOW = 30 * DAY;
const OPEN_STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];

before(() => {
  db.close();
  db.open(":memory:");
});

test("overview counts every ticket surface and status within the analytics window", async () => {
  const now = Date.now();
  const programId = "f5-analytics";
  const program = {
    id: programId,
    name: "F5 Analytics",
    posture: "passive",
    workspaceId: "ws-f5",
    helpChannel: "C-f5",
    channels: ["C-f5"],
    ticketVisibility: "dashboard",
  };
  db.saveProgram(program);

  const insert = ({ status = "open", channel = "C-f5", threadTs, ageMs = DAY, resolvedAgeMs = null }) => {
    const id = db.createTicket({
      programId,
      workspaceId: "ws-f5",
      channel,
      threadTs,
      requesterId: `U-${threadTs}`,
      question: `question for ${threadTs}`,
    });
    const createdAt = now - ageMs;
    const resolvedAt = resolvedAgeMs === null ? null : now - resolvedAgeMs;
    db.handle().query(
      "UPDATE tickets SET status = ?, created_at = ?, updated_at = ?, resolved_at = ? WHERE id = ?",
    ).run(status, createdAt, createdAt, resolvedAt, id);
    return { id, status, createdAt, resolvedAt };
  };

  const dashboardOnly = await tickets.ensureSupportTicket({
    program,
    channel: "C-f5",
    threadTs: "f5-dashboard-only",
    requesterId: "U-dashboard",
    question: "dashboard-only question",
  });
  assert.ok(dashboardOnly, "dashboard-only tickets must still be persisted");
  const dashboardCreatedAt = now - 2 * HOUR;
  db.handle().query("UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(dashboardCreatedAt, dashboardCreatedAt, dashboardOnly.id);

  const inWindow = [
    { status: "open", channel: "C-f5", threadTs: "f5-open", ageMs: 3 * DAY },
    { status: "waiting_for_helper", channel: "C-f5", threadTs: "f5-waiting", ageMs: 4 * DAY },
    { status: "claimed", channel: "D-f5", threadTs: "f5-claimed", ageMs: 5 * DAY },
    { status: "assigned", channel: "C-f5", threadTs: "f5-assigned", ageMs: 6 * DAY },
    { status: "escalated", channel: "C-f5", threadTs: "f5-escalated", ageMs: 7 * DAY },
    { status: "reopened", channel: "C-f5", threadTs: "f5-reopened", ageMs: 8 * DAY },
    { status: "resolved", channel: "C-f5", threadTs: "f5-resolved-today", ageMs: DAY, resolvedAgeMs: 2 * HOUR },
    { status: "resolved", channel: "C-f5", threadTs: "f5-resolved-yesterday", ageMs: 2 * DAY, resolvedAgeMs: 30 * HOUR },
    { status: "closed", channel: "C-f5", threadTs: "f5-closed", ageMs: 9 * DAY, resolvedAgeMs: 3 * DAY },
    { status: "duplicate", channel: "C-f5", threadTs: "f5-duplicate", ageMs: 10 * DAY },
    { status: "snoozed", channel: "C-f5", threadTs: "f5-snoozed", ageMs: 11 * DAY },
    { status: "spam", channel: "C-f5", threadTs: "f5-spam", ageMs: 12 * DAY },
  ].map(insert);

  insert({ status: "open", channel: "C-f5", threadTs: "f5-old-open", ageMs: WINDOW + DAY });
  insert({ status: "resolved", channel: "D-f5", threadTs: "f5-old-resolved-today", ageMs: WINDOW + DAY, resolvedAgeMs: 3 * HOUR });

  const expectedByStatus = {
    open: 2,
    waiting_for_helper: 1,
    claimed: 1,
    assigned: 1,
    escalated: 1,
    reopened: 1,
    resolved: 2,
    closed: 1,
    duplicate: 1,
    snoozed: 1,
    spam: 1,
  };
  const expectedDaily = [{ createdAt: dashboardCreatedAt }, ...inWindow].reduce((days, row) => {
    const date = new Date(row.createdAt).toISOString().slice(0, 10);
    days[date] = (days[date] || 0) + 1;
    return days;
  }, Object.create(null));

  const first = analytics.overview(programId, WINDOW);
  assert.deepEqual(analytics.OPEN_STATUSES, OPEN_STATUSES);
  assert.equal(first.created, 13);
  assert.deepEqual({ ...expectedByStatus, resolved: 3 }, first.byStatus);
  assert.equal(first.resolvedInWindow, 3);
  assert.equal(first.openCount, 7);
  assert.equal(first.waitingCount, 1);
  assert.equal(first.resolvedToday, 2, "resolved today is independent of created window");
  assert.equal(first.stale48h, 4, "stale count is also restricted to the analytics window");
  assert.deepEqual(
    Object.fromEntries(first.daily.filter((day) => day.questions > 0).map((day) => [day.date, day.questions])),
    expectedDaily,
  );

  const realtimeId = db.createTicket({
    programId,
    workspaceId: "ws-f5",
    channel: "D-f5",
    threadTs: "f5-realtime",
    requesterId: "U-realtime",
    question: "new ticket appears immediately",
  });
  assert.ok(realtimeId);
  const second = analytics.overview(programId, WINDOW);
  assert.equal(second.created, 14);
  assert.equal(second.byStatus.open, 3);
  assert.equal(second.openCount, 8);
});
