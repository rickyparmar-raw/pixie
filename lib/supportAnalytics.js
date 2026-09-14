// Deterministic support analytics. Every number is computed from stored rows
// with indexed queries — no full-table loads, no model calls. An optional AI
// insights layer may explain these numbers but receives only the computed
// aggregates and must never invent its own.
const db = require("./db");

// WHY: 30d is a full operating cycle — long enough to smooth weekly rhythm,
// short enough that old regimes don't mask this week's reality.
const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000;
// WHY: 48h without movement means the requester waited two full workdays;
// assigned/claimed tickets have an owner on point, so only ownerless states
// count here (narrower than the SLA/radar open set by design).
const STALE48H_MS = 48 * 60 * 60 * 1000;
const STALE48H_STATUSES = ["open", "waiting_for_helper", "escalated", "reopened"];
// WHY: gap trends only matter while fresh — a week of misses is a backlog,
// a month of misses is history already covered by the radar's FAQ detector.
const GAP_COUNTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function median(values) {
  const sorted = [...values].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function lags(rows, from, to) {
  return rows.map((r) => r[to] - r[from]).filter((n) => Number.isFinite(n) && n >= 0);
}

// WHY: rates round to 3 decimals — precise enough to graph, too coarse to
// invite fake-precision arguments about a 0.0004 wobble.
function rate(n, d) {
  return d > 0 ? Number((n / d).toFixed(3)) : 0;
}

// UTC day buckets, not local ones: the series is read by dashboards in every
// timezone, and a local-day key would silently shift every bucket depending
// on where the server happens to run.
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// One row per day in the window, zero-filled — a quiet day has to read as a
// zero on the chart, not as a gap the line smooths over. Buckets by the day
// the question arrived and splits it by who ended up answering, so the three
// figures always sum to the day's volume: handled by the bot alone, needed a
// person, still unanswered.
function dailySeries(rows, cutoff, now) {
  const days = new Map();
  for (let t = Date.parse(`${utcDay(cutoff)}T00:00:00Z`); t <= now; t += 86400000) {
    const date = utcDay(t);
    days.set(date, { date, questions: 0, aiOnly: 0, human: 0 });
  }
  for (const row of rows) {
    const day = days.get(utcDay(row.created_at));
    if (!day) continue;
    day.questions += 1;
    if (row.first_human_response_at) day.human += 1;
    else if (row.first_response_at) day.aiOnly += 1;
  }
  return [...days.values()];
}

function overview(programId, sinceMs = DEFAULT_SINCE_MS) {
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
     AND status IN (${STALE48H_STATUSES.map(() => "?").join(",")}) AND created_at < ?`,
  ).get(programId, ...STALE48H_STATUSES, Date.now() - STALE48H_MS).n;

  const duplicates = counts.duplicate || 0;
  const gapCounts = db.gapCountsByKind(GAP_COUNTS_WINDOW_MS, null, programId);
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
    reopenRate: rate(reopened, created),
    duplicates,
    duplicateRate: rate(duplicates, created),
    aiAnswered,
    humanHandled,
    deflected,
    deflectionRate: rate(deflected, resolved.length),
    medianFirstResponseMs: median(lags(times, "created_at", "first_response_at")),
    medianFirstHumanResponseMs: median(lags(times, "created_at", "first_human_response_at")),
    medianResolveMs: median(lags(times, "created_at", "resolved_at")),
    byCategory,
    daily: dailySeries(times, cutoff, Date.now()),
    helperLoad,
    helperResolved,
    stale48h: stale,
    gapCounts,
    incidents: Object.fromEntries(incidents.map((r) => [r.status, r.n])),
    activityKinds: Object.fromEntries(kinds.map((r) => [r.kind, r.n])),
  };
}

module.exports = { overview, median };
