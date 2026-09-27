// Configurable retention. Each program sets day-windows per class; approved
// knowledge defaults to keep (verified facts survive their source ticket).
// Audit has a platform floor (AUDIT_MIN_DAYS) no program setting can go
// under. sweepProgram supports dryRun previews; real runs delete in tenant
// scope inside a transaction and audit counts only — never deleted content.
import db = require("./db");
import audit = require("./audit");

// A year of audit history is the incident-response minimum — shorter windows
// would delete the trail before annual reviews. Raisable, never lowerable.
const AUDIT_MIN_DAYS = 365;
const DEFAULTS = {
  contextDays: 30,
  ticketsDays: 180,
  tracesDays: 30,
  analyticsDays: 365,
  auditDays: 365,
  knowledge: "keep",
};
// Only terminal states are ever swept: anything a helper could still act on
// stays regardless of age.
const SWEEPABLE_STATUSES = ["resolved", "closed", "duplicate", "spam"];
const DAY_MS = 86400000;
// Internal notes follow their ticket's lifetime: deleting a note while its
// ticket survives would corrupt helper context, so there is no independent
// notes window. Ticket deletion removes its notes and timeline together.

function toPositiveDays(value: any, fallback: any) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function policyFor(programId: any) {
  const row = db.handle().query(
    `SELECT retention_context_days, retention_tickets_days,
            retention_traces_days, retention_analytics_days, retention_audit_days
     FROM programs WHERE id = ?`,
  ).get(programId) || {};
  return {
    contextDays: toPositiveDays(row.retention_context_days, DEFAULTS.contextDays),
    ticketsDays: toPositiveDays(row.retention_tickets_days, DEFAULTS.ticketsDays),
    tracesDays: toPositiveDays(row.retention_traces_days, DEFAULTS.tracesDays),
    analyticsDays: toPositiveDays(row.retention_analytics_days, DEFAULTS.analyticsDays),
    // Platform floor: audit retention can be raised, never lowered past it.
    auditDays: Math.max(toPositiveDays(row.retention_audit_days, DEFAULTS.auditDays), AUDIT_MIN_DAYS),
    knowledge: "keep",
  };
}

function validatePolicy(patch: Record<string, any> = {}) {
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

function eligibleTicketIds(h: any, programId: any, ticketCutoff: any) {
  const placeholders = SWEEPABLE_STATUSES.map(() => "?").join(",");
  return h.query(
    `SELECT id FROM tickets WHERE program_id = ? AND created_at < ? AND status IN (${placeholders})`,
  ).all(programId, ticketCutoff, ...SWEEPABLE_STATUSES).map((t: any) => t.id);
}

function countFor(h: any, sql: any, ...params: any) {
  return h.query(sql).get(...params);
}

function preview(programId: any, now = Date.now()) {
  const p = policyFor(programId);
  const h = db.handle();
  const ticketCutoff = now - p.ticketsDays * DAY_MS;
  const ids = eligibleTicketIds(h, programId, ticketCutoff);
  let events = 0;
  let notes = 0;
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    events = countFor(h, `SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id IN (${placeholders})`, ...ids).n;
    // Sweep deletes every note attached to an eligible ticket, so the preview
    // counts the same set rather than only notes past their own window.
    notes = countFor(h, `SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id IN (${placeholders})`, ...ids).n;
  }
  return {
    programId,
    policy: p,
    tickets: ids.length,
    ticketEvents: events,
    notes,
    metrics: countFor(h, "SELECT COUNT(*) AS n FROM metrics WHERE program_id = ? AND created_at < ?", programId, now - p.analyticsDays * DAY_MS).n,
    gaps: countFor(h, "SELECT COUNT(*) AS n FROM doc_gaps WHERE program_id = ? AND created_at < ?", programId, now - p.tracesDays * DAY_MS).n,
    auditEligible: 0,
  };
}

function deleteTicketScope(h: any, ids: any) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  h.query(`DELETE FROM ticket_events WHERE ticket_id IN (${placeholders})`).run(...ids);
  h.query(`DELETE FROM ticket_notes WHERE ticket_id IN (${placeholders})`).run(...ids);
  h.query(`DELETE FROM tickets WHERE id IN (${placeholders})`).run(...ids);
}

function sweepProgram(programId: any, { dryRun = true, now = Date.now() }: Record<string, any> = {}) {
  const result = preview(programId, now);
  if (dryRun) return { ...result, deleted: false };
  const p = result.policy;
  const h = db.handle();
  const ids = eligibleTicketIds(h, programId, now - p.ticketsDays * DAY_MS);
  // Open/active tickets are never retention-deleted, whatever their age.
  h.transaction(() => {
    deleteTicketScope(h, ids);
    h.query("DELETE FROM metrics WHERE program_id = ? AND created_at < ?").run(programId, now - p.analyticsDays * DAY_MS);
    h.query("DELETE FROM doc_gaps WHERE program_id = ? AND created_at < ?").run(programId, now - p.tracesDays * DAY_MS);
    h.query("DELETE FROM sla_notifications WHERE program_id = ? AND sent_at < ?").run(programId, now - p.analyticsDays * DAY_MS);
  })();
  audit.record({ programId, actorId: null, action: "retention.sweep", entityType: "program", entityId: programId, metadata: { tickets: result.tickets, events: result.ticketEvents, notes: result.notes } });
  return { ...result, deleted: true };
}

export = { policyFor, validatePolicy, preview, sweepProgram, DEFAULTS, AUDIT_MIN_DAYS };
