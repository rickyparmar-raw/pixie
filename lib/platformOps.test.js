process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const analytics = require("./supportAnalytics");
const sla = require("./sla");
const retention = require("./retention");
const lease = require("./jobLease");
const api = require("./web/api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

test("analytics computes deterministic tenant-scoped numbers", () => {
  db.saveProgram({ id: "an-hwy", name: "Highway", helpChannel: "C-HWY", channels: ["C-HWY"] });
  programs.invalidate();
  const base = Date.now() - 100000;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(db.createTicket({ programId: "an-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: `an-t-${i}`, requesterId: "U1", question: "q", category: "ordering" }));
  }
  db.handle().query("UPDATE tickets SET created_at = ?, first_response_at = ?, first_human_response_at = ?, resolved_at = ?, status='resolved' WHERE id = ?")
    .run(base, base + 60000, base + 120000, base + 300000, ids[0]);
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(base, ids[1]);
  db.resolveTicket(ids[2], "bot handled");

  const a = analytics.overview("an-hwy");
  assert.equal(a.created, 3);
  assert.equal(a.byStatus.resolved, 2);
  assert.equal(a.aiAnswered, 2);
  assert.equal(a.humanHandled, 1);
  assert.equal(a.deflected, 1);
  assert.equal(a.medianFirstResponseMs, 60000);
  assert.equal(a.medianFirstHumanResponseMs, 120000);
  assert.equal(a.medianResolveMs, 300000);
  assert.equal(a.byCategory[0].category, "ordering");

  const empty = analytics.overview("an-nobody");
  assert.equal(empty.created, 0);
  assert.equal(empty.medianResolveMs, null);
  assert.equal(empty.reopenRate, 0);
});

test("SLA flags violations, cools down notifications, suggests actions", () => {
  db.saveProgram({ id: "sla-hwy", name: "S", helpChannel: "C-S", channels: ["C-S"], sla: { unassignedMs: 60000, assignedMs: 60000, notifyChannel: "C-S" } });
  programs.invalidate();
  const old = Date.now() - 3600000;
  const id = db.createTicket({ programId: "sla-hwy", workspaceId: "T1", channel: "C-S", threadTs: "sla-t1", requesterId: "U1", question: "q" });
  db.handle().query("UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?").run(old, old, id);

  const checked = sla.checkProgram({ programId: "sla-hwy" });
  assert.equal(checked.violations.length, 1);
  assert.equal(checked.violations[0].rule, "unassigned");

  const due = sla.dueNotifications({ programId: "sla-hwy", violations: checked.violations });
  assert.equal(due.length, 1);
  sla.markNotified({ programId: "sla-hwy", ticketId: id, rule: "unassigned" });
  assert.equal(sla.dueNotifications({ programId: "sla-hwy", violations: checked.violations }).length, 0);
  assert.match(sla.suggestAction(checked.violations[0]), /recommend/);

  const off = sla.checkProgram({ programId: "an-hwy" });
  assert.equal(off.violations.length, 0);
});

test("retention previews, enforces the audit floor, and deletes tenant-scoped", () => {
  db.saveProgram({ id: "ret-hwy", name: "R", helpChannel: "C-R", channels: ["C-R"], retention: { ticketsDays: 30, auditDays: 10 } });
  programs.invalidate();
  assert.equal(retention.validatePolicy({ auditDays: 10 }), `audit retention cannot go below the platform minimum of 365 days`);
  assert.equal(retention.validatePolicy({ ticketsDays: 30 }), null);
  // Floor wins over the stored 10.
  assert.equal(retention.policyFor("ret-hwy").auditDays, 365);
  assert.equal(retention.policyFor("ret-hwy").ticketsDays, 30);

  const ancient = Date.now() - 60 * 86400000;
  const id = db.createTicket({ programId: "ret-hwy", workspaceId: "T1", channel: "C-R", threadTs: "ret-t1", requesterId: "U1", question: "q" });
  db.resolveTicket(id, "done");
  db.addTicketEvent({ ticketId: id, programId: "ret-hwy", actorId: "U1", eventType: "resolved" });
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(ancient, id);

  const open = db.createTicket({ programId: "ret-hwy", workspaceId: "T1", channel: "C-R", threadTs: "ret-t2", requesterId: "U1", question: "q2" });
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(ancient, open);

  const prev = retention.preview("ret-hwy");
  assert.equal(prev.tickets, 1);
  assert.equal(prev.ticketEvents, 1);

  const swept = retention.sweepProgram("ret-hwy", { dryRun: false });
  assert.equal(swept.deleted, true);
  assert.equal(db.getTicket(id), null);
  assert.ok(db.getTicket(open), "open tickets survive regardless of age");

  // Other tenants untouched.
  const other = db.createTicket({ programId: "ret-other", workspaceId: "T1", channel: "CX", threadTs: "ret-t3", requesterId: "U1", question: "q" });
  db.resolveTicket(other, "done");
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(ancient, other);
  retention.sweepProgram("ret-hwy", { dryRun: false });
  assert.ok(db.getTicket(other));
});

test("job leases are single-flight with expiry takeover", () => {
  const a = lease.acquire("test-job", 60000);
  assert.equal(a.held, true);
  assert.equal(lease.acquire("test-job", 60000).held, false);
  lease.release("test-job", a.owner);
  assert.equal(lease.acquire("test-job", 60000).held, true);
  const b = lease.acquire("test-job", 60000);
  void b;
  // Expired leases can be taken over.
  db.handle().query("UPDATE job_leases SET expires_at = ? WHERE name = 'test-job'").run(Date.now() - 1);
  assert.equal(lease.acquire("test-job", 60000).held, true);
});

test("analytics/SLA/retention routes reject unknown programs", () => {
  assert.match(api.internalAnalytics("nope", {}).error, /unknown program/);
  assert.match(api.internalSlaCheck("nope").error, /unknown program/);
  assert.match(api.internalRetentionPreview("nope").error, /unknown program/);
});
