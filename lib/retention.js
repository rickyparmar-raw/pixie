// Configurable retention. Each program sets day-windows per class; approved
// knowledge defaults to keep (verified facts survive their source ticket).
// Audit has a platform floor (AUDIT_MIN_DAYS) no program setting can go
// under. sweepProgram supports dryRun previews; real runs delete in tenant
// scope inside a transaction and audit counts only — never deleted content.
const db = require("./db");
const audit = require("./audit");

const AUDIT_MIN_DAYS = 365;
const DEFAULTS = {
  contextDays: 30,
  ticketsDays: 180,
  notesDays: 180,
  tracesDays: 30,
  analyticsDays: 365,
  auditDays: 365,
  knowledge: "keep",
};

function policyFor(programId) {
  const row = db.handle().query(
    `SELECT retention_context_days, retention_tickets_days, retention_notes_days,
            retention_traces_days, retention_analytics_days, retention_audit_days
     FROM programs WHERE id = ?`,
  ).get(programId) || {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return {
    contextDays: num(row.retention_context_days, DEFAULTS.contextDays),
    ticketsDays: num(row.retention_tickets_days, DEFAULTS.ticketsDays),
    notesDays: num(row.retention_notes_days, DEFAULTS.notesDays),
    tracesDays: num(row.retention_traces_days, DEFAULTS.tracesDays),
    analyticsDays: num(row.retention_analytics_days, DEFAULTS.analyticsDays),
    // Platform floor: audit retention can be raised, never lowered past it.
    auditDays: Math.max(num(row.retention_audit_days, DEFAULTS.auditDays), AUDIT_MIN_DAYS),
    knowledge: "keep",
  };
}

function validatePolicy(patch = {}) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "knowledge") {
      if (value !== "keep") return "only 'keep' is supported for approved knowledge";
      continue;
    }
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return `${key} must be a positive number of days`;
  }
  if (patch.auditDays !== undefined && Number(patch.auditDays) < AUDIT_MIN_DAYS) {
    return `audit retention cannot go below the platform minimum of ${AUDIT_MIN_DAYS} days`;
  }
  return null;
}

function preview(programId, now = Date.now()) {
  const p = policyFor(programId);
  const h = db.handle();
  const count = (sql, ...params) => h.query(sql).get(...params);
  const ticketCutoff = now - p.ticketsDays * 86400000;
  const oldTickets = h.query("SELECT id FROM tickets WHERE program_id = ? AND created_at < ? AND status IN ('resolved','closed','duplicate','spam')").all(programId, ticketCutoff);
  const ids = oldTickets.map((t) => t.id);
  let events = 0;
  let notes = 0;
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    events = count(`SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id IN (${placeholders})`, ...ids).n;
    notes = count(`SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id IN (${placeholders}) AND created_at < ?`, ...ids, now - p.notesDays * 86400000).n;
  }
  return {
    programId,
    policy: p,
    tickets: oldTickets.length,
    ticketEvents: events,
    notes,
    metrics: count("SELECT COUNT(*) AS n FROM metrics WHERE program_id = ? AND created_at < ?", programId, now - p.analyticsDays * 86400000).n,
    gaps: count("SELECT COUNT(*) AS n FROM doc_gaps WHERE program_id = ? AND created_at < ?", programId, now - p.tracesDays * 86400000).n,
    auditEligible: 0,
  };
}

function sweepProgram(programId, { dryRun = true, now = Date.now() } = {}) {
  const result = preview(programId, now);
  if (dryRun) return { ...result, deleted: false };
  const p = result.policy;
  const h = db.handle();
  const ticketCutoff = now - p.ticketsDays * 86400000;
  const oldTickets = h.query("SELECT id FROM tickets WHERE program_id = ? AND created_at < ? AND status IN ('resolved','closed','duplicate','spam')").all(programId, ticketCutoff);
  const ids = oldTickets.map((t) => t.id);
  // Open/active tickets are never retention-deleted, whatever their age.
  const tx = h.transaction(() => {
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      h.query(`DELETE FROM ticket_events WHERE ticket_id IN (${placeholders})`).run(...ids);
      h.query(`DELETE FROM ticket_notes WHERE ticket_id IN (${placeholders})`).run(...ids);
      h.query(`DELETE FROM tickets WHERE id IN (${placeholders})`).run(...ids);
    }
    h.query("DELETE FROM metrics WHERE program_id = ? AND created_at < ?").run(programId, now - p.analyticsDays * 86400000);
    h.query("DELETE FROM doc_gaps WHERE program_id = ? AND created_at < ?").run(programId, now - p.tracesDays * 86400000);
    h.query("DELETE FROM sla_notifications WHERE program_id = ? AND sent_at < ?").run(programId, now - p.analyticsDays * 86400000);
  });
  tx();
  audit.record({ programId, actorId: null, action: "retention.sweep", entityType: "program", entityId: programId, metadata: { tickets: result.tickets, events: result.ticketEvents, notes: result.notes } });
  return { ...result, deleted: true };
}

module.exports = { policyFor, validatePolicy, preview, sweepProgram, DEFAULTS, AUDIT_MIN_DAYS };
