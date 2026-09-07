// Deterministic support analytics. Every number is computed from stored rows
// with indexed queries — no full-table loads, no model calls. An optional AI
// insights layer may explain these numbers but receives only the computed
// aggregates and must never invent its own.
const db = require("./db");

function median(values) {
  const sorted = [...values].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function lags(rows, from, to) {
  return rows.map((r) => r[to] - r[from]).filter((n) => Number.isFinite(n) && n >= 0);
}

function overview(programId, sinceMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  const byStatus = db.handle().query(
    "SELECT status, COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ? GROUP BY status",
  ).all(programId, cutoff);
  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  const created = byStatus.reduce((n, r) => n + r.n, 0);

  const times = db.handle().query(
    "SELECT created_at, first_response_at, first_human_response_at, resolved_at, reopen_count FROM tickets WHERE program_id = ? AND created_at > ?",
  ).all(programId, cutoff);

  const resolved = times.filter((t) => t.resolved_at);
  const reopened = times.filter((t) => (t.reopen_count || 0) > 0).length;
  const aiAnswered = times.filter((t) => t.first_response_at).length;
  const humanHandled = times.filter((t) => t.first_human_response_at).length;
  const deflected = resolved.filter((t) => !t.first_human_response_at).length;

  const byCategory = db.handle().query(
    "SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ? GROUP BY category ORDER BY n DESC",
  ).all(programId, cutoff);

  const helperLoad = db.handle().query(
    `SELECT assignee_id AS userId, COUNT(*) AS openAssigned FROM tickets
     WHERE program_id = ? AND assignee_id IS NOT NULL AND status IN ('claimed','assigned','waiting_for_helper','escalated','reopened')
     GROUP BY assignee_id`,
  ).all(programId);

  const helperResolved = db.handle().query(
    `SELECT assignee_id AS userId, COUNT(*) AS resolved FROM tickets
     WHERE program_id = ? AND assignee_id IS NOT NULL AND status = 'resolved' AND created_at > ? GROUP BY assignee_id`,
  ).all(programId, cutoff);

  const stale = db.handle().query(
    `SELECT COUNT(*) AS n FROM tickets WHERE program_id = ?
     AND status IN ('open','waiting_for_helper','escalated','reopened') AND created_at < ?`,
  ).get(programId, Date.now() - 48 * 60 * 60 * 1000).n;

  const duplicates = counts.duplicate || 0;
  const gapCounts = db.gapCountsByKind(7 * 24 * 60 * 60 * 1000, null, programId);
  const incidents = db.handle().query(
    "SELECT status, COUNT(*) AS n FROM program_incidents WHERE program_id = ? GROUP BY status",
  ).all(programId);

  const kinds = db.handle().query(
    "SELECT kind, COUNT(*) AS n FROM metrics WHERE (program_id = ? OR program_id IS NULL) AND created_at > ? GROUP BY kind",
  ).all(programId, cutoff);

  return {
    programId,
    windowDays: Math.round(sinceMs / 86400000),
    created,
    byStatus: counts,
    reopened,
    reopenRate: created > 0 ? Number((reopened / created).toFixed(3)) : 0,
    duplicates,
    duplicateRate: created > 0 ? Number((duplicates / created).toFixed(3)) : 0,
    aiAnswered,
    humanHandled,
    deflected,
    deflectionRate: resolved.length > 0 ? Number((deflected / resolved.length).toFixed(3)) : 0,
    medianFirstResponseMs: median(lags(times, "created_at", "first_response_at")),
    medianFirstHumanResponseMs: median(lags(times, "created_at", "first_human_response_at")),
    medianResolveMs: median(lags(times, "created_at", "resolved_at")),
    byCategory,
    helperLoad,
    helperResolved,
    stale48h: stale,
    gapCounts,
    incidents: Object.fromEntries(incidents.map((r) => [r.status, r.n])),
    activityKinds: Object.fromEntries(kinds.map((r) => [r.kind, r.n])),
  };
}

module.exports = { overview, median };
