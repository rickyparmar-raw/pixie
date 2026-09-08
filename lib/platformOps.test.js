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

/* ------------------------------------------------------------------ */
/* STEP 1 characterization pins (RADAR/ANALYTICS/SLA domain): exact   */
/* SLA thresholds/cooldown/skip ownership and analytics shapes.       */
/* ------------------------------------------------------------------ */

function charSlaTicket(programId, threadTs, ageMs, status = "open") {
  const id = db.createTicket({ programId, workspaceId: "T1", channel: `C-${programId}`, threadTs, requesterId: "U1", question: "q" });
  db.handle().query("UPDATE tickets SET created_at = ?, updated_at = ?, status = ? WHERE id = ?")
    .run(Date.now() - ageMs, Date.now() - ageMs, status, id);
  return id;
}

test("char: SLA thresholds are per-rule; null means off", () => {
  db.saveProgram({ id: "csla-off", name: "S", helpChannel: "C-csla-off", channels: ["C-csla-off"], sla: { unassignedMs: 60000 } });
  programs.invalidate();
  // Only the unassigned rule is armed: old waiting/assigned tickets stay clean.
  charSlaTicket("csla-off", "csla-off-w", 3600000, "waiting_for_helper");
  const wid = db.createTicket({ programId: "csla-off", workspaceId: "T1", channel: "C-csla-off", threadTs: "csla-off-a", requesterId: "U1", question: "q" });
  db.assignTicket(wid, "U-helper");
  db.handle().query("UPDATE tickets SET assigned_at = ? WHERE id = ?").run(Date.now() - 3600000, wid);
  const checked = sla.checkProgram({ programId: "csla-off" });
  assert.ok(checked.violations.every((v) => v.rule === "unassigned"));
  assert.ok(!checked.violations.some((v) => v.ticketId === wid));
});

test("char: SLA pins waiting_for_helper, assigned_no_response, and claimed mapping", () => {
  db.saveProgram({ id: "csla-rules", name: "S", helpChannel: "C-csla-rules", channels: ["C-csla-rules"], sla: { unassignedMs: 60000, assignedMs: 60000, waitingMs: 60000 } });
  programs.invalidate();
  const w = charSlaTicket("csla-rules", "csla-rules-w", 3600000, "waiting_for_helper");
  const a = db.createTicket({ programId: "csla-rules", workspaceId: "T1", channel: "C-csla-rules", threadTs: "csla-rules-a", requesterId: "U1", question: "q" });
  db.assignTicket(a, "U-helper");
  db.handle().query("UPDATE tickets SET assigned_at = ? WHERE id = ?").run(Date.now() - 3600000, a);
  // assigned_at NULL falls back to created_at.
  const f = charSlaTicket("csla-rules", "csla-rules-f", 3600000, "assigned");
  db.handle().query("UPDATE tickets SET assignee_id = ?, assigned_at = NULL WHERE id = ?").run("U-helper", f);
  const c = charSlaTicket("csla-rules", "csla-rules-c", 3600000, "claimed");
  db.handle().query("UPDATE tickets SET assignee_id = ? WHERE id = ?").run("U-helper", c);
  const checked = sla.checkProgram({ programId: "csla-rules" });
  const byId = Object.fromEntries(checked.violations.map((v) => [v.ticketId, v.rule]));
  assert.equal(byId[w], "waiting_for_helper");
  assert.equal(byId[a], "assigned_no_response");
  assert.equal(byId[f], "assigned_no_response");
  assert.equal(byId[c], "assigned_no_response");
});

test("char: SLA cooldown is a strict 24h per (program,ticket,rule)", () => {
  assert.equal(sla.NOTIFY_COOLDOWN_MS, 24 * 60 * 60 * 1000);
  db.saveProgram({ id: "csla-cd", name: "S", helpChannel: "C-csla-cd", channels: ["C-csla-cd"], sla: { unassignedMs: 60000 } });
  programs.invalidate();
  const id = charSlaTicket("csla-cd", "csla-cd-1", 3600000, "open");
  const violations = sla.checkProgram({ programId: "csla-cd" }).violations;
  assert.equal(violations.length, 1);
  const t0 = Date.now();
  sla.markNotified({ programId: "csla-cd", ticketId: id, rule: "unassigned", now: t0 });
  assert.deepEqual(sla.dueNotifications({ programId: "csla-cd", violations, now: t0 + sla.NOTIFY_COOLDOWN_MS }), []);
  assert.equal(sla.dueNotifications({ programId: "csla-cd", violations, now: t0 + sla.NOTIFY_COOLDOWN_MS + 1 }).length, 1);
  // Cooldown key includes the rule: another rule for the same ticket is still due.
  assert.equal(sla.dueNotifications({ programId: "csla-cd", violations: [{ ticketId: id, rule: "waiting_for_helper" }], now: t0 }).length, 1);
});

test("char: SLA loop guards; checkProgram itself never skips shadow/ysws-global", () => {
  assert.equal(sla.startSlaLoop(null), null);
  assert.equal(sla.startSlaLoop({}, 0), null);
  const timer = sla.startSlaLoop({}, 100000);
  assert.ok(timer);
  clearInterval(timer);
  // Skip ownership lives in startSlaLoop, not checkProgram: even a shadow or
  // ysws-global program still reports violations when checked directly.
  db.saveProgram({ id: "csla-shadow", name: "S", helpChannel: "C-x", channels: ["C-x"], shadowMode: true, sla: { unassignedMs: 60000 } });
  db.saveProgram({ id: "ysws-global", name: "G", helpChannel: "C-g", channels: ["C-g"], sla: { unassignedMs: 60000 } });
  programs.invalidate();
  charSlaTicket("csla-shadow", "csla-shadow-1", 3600000, "open");
  charSlaTicket("ysws-global", "ysws-global-1", 3600000, "open");
  assert.equal(sla.checkProgram({ programId: "csla-shadow" }).violations.length, 1);
  assert.equal(sla.checkProgram({ programId: "ysws-global" }).violations.length, 1);
});

test("char: analytics stale48h uses a narrower status set than the SLA/radar open set", () => {
  db.saveProgram({ id: "can-stale", name: "S", helpChannel: "C-can-stale", channels: ["C-can-stale"] });
  programs.invalidate();
  charSlaTicket("can-stale", "can-stale-assigned", 50 * 60 * 60 * 1000, "assigned");
  let a = analytics.overview("can-stale");
  assert.equal(a.stale48h, 0); // assigned is open for SLA/radar but not stale48h
  charSlaTicket("can-stale", "can-stale-open", 50 * 60 * 60 * 1000, "open");
  a = analytics.overview("can-stale");
  assert.equal(a.stale48h, 1);
});

test("char: analytics median is upper-median, drops negatives, null on empty", () => {
  assert.equal(analytics.median([3, 1, 2]), 2);
  assert.equal(analytics.median([1, 2, 3, 4]), 3);
  assert.equal(analytics.median([-5, 10]), 10);
  assert.equal(analytics.median([]), null);
});

test("char: analytics overview is tenant-scoped", () => {
  db.saveProgram({ id: "can-tenant-a", name: "A", helpChannel: "C-A", channels: ["C-A"] });
  db.saveProgram({ id: "can-tenant-b", name: "B", helpChannel: "C-B", channels: ["C-B"] });
  programs.invalidate();
  for (let i = 0; i < 2; i++) {
    db.createTicket({ programId: "can-tenant-a", workspaceId: "T1", channel: "C-A", threadTs: `can-ta-${i}`, requesterId: "U1", question: "q" });
  }
  const b = analytics.overview("can-tenant-b");
  assert.equal(b.created, 0);
  assert.equal(analytics.overview("can-tenant-a").created, 2);
});

/* ------------------------------------------------------------------ */
/* STEP 1 pins (platformOps INTERNAL surface): retention sweep gate +  */
/* analytics/SLA/retention shapes carry no secrets. Append-only.       */
/* ------------------------------------------------------------------ */

test("char: retention sweep via the internal API needs organizer + confirm", () => {
  const sync = api.internalProgramSync("can-ret-api", { name: "R", workspaceId: "T1", claimedBy: "U-can-org", programChannels: [] });
  assert.equal(sync.ok, true);
  db.syncHelper({ programId: "can-ret-api", userId: "U-can-helper", source: "manual" });
  assert.match(api.internalRetentionSweep("can-ret-api", { actorId: "U-can-helper", confirm: true }).error, /organizer/);
  assert.match(api.internalRetentionSweep("can-ret-api", { actorId: "U-can-org" }).error, /confirm required/);
  assert.equal(api.internalRetentionSweep("can-ret-api", { actorId: "U-can-org", confirm: true }).deleted, true);
  // Retention policy rejects the audit floor and echoes the effective policy.
  assert.match(api.internalRetentionPolicy("can-ret-api", { actorId: "U-can-org", policy: { auditDays: 10 } }).error, /platform minimum/);
  assert.match(api.internalRetentionPolicy("can-ret-api", { actorId: "U-stranger", policy: { ticketsDays: 30 } }).error, /not a helper/);
  const ok = api.internalRetentionPolicy("can-ret-api", { actorId: "U-can-org", policy: { ticketsDays: 30 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.policy.ticketsDays, 30);
});

test("char: analytics/SLA/retention-preview shapes are counts, never secrets", () => {
  db.saveProgram({ id: "can-shape", name: "S", helpChannel: "C-can-shape", channels: ["C-can-shape"] });
  programs.invalidate();
  const a = api.internalAnalytics("can-shape", {});
  assert.ok(typeof a.created === "number" && a.byStatus);
  const s = api.internalSlaCheck("can-shape");
  assert.ok(Array.isArray(s.violations));
  const p = api.internalRetentionPreview("can-shape");
  assert.ok(typeof p.tickets === "number" && p.policy);
  for (const blob of [JSON.stringify(a), JSON.stringify(s), JSON.stringify(p)]) {
    assert.equal(/xoxb-/.test(blob), false);
    assert.equal(/"secret"\s*:/i.test(blob), false);
    assert.equal(/PIXIE_INTERNAL_TOKEN/.test(blob), false);
  }
});
