// Ticket metrics are the read-side source of truth for support reporting.
//
// A ticket is resolved only while its current status is exactly `resolved`.
// `closed`, `duplicate`, `spam`, reopened, and every other state are not
// resolved. A resolution window is always bounded by `resolved_at`, never by
// ticket creation time. Exactly one helper may receive credit for a resolved
// ticket: `resolved_credit_id`, written when the ticket is resolved. Rows from
// before that column existed use the historical fallback below, which accepts
// any program helper who replied (including helpers who are inactive now),
// then the assignee, then `resolved_by`.
//
// All queries are program-scoped and use the indexed tickets/ticket_events
// tables. The small JS reductions are only for medians and response-shape
// assembly; no metric calls the live routing attribution logic.
const db = require("./db");

const OPEN_STATUSES = Object.freeze(["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"]);
const OPEN_SQL = OPEN_STATUSES.map(() => "?").join(",");

function sinceValue(since) {
  if (since === undefined || since === null || since === "") return 0;
  const value = Number(since);
  return Number.isFinite(value) ? value : 0;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
}

const CREDIT_SQL = `COALESCE(
  t.resolved_credit_id,
  (SELECT e.actor_id FROM ticket_events e
   WHERE e.ticket_id = t.id AND e.program_id = t.program_id
     AND e.event_type = 'helper_reply' AND e.actor_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM program_helpers ph
                 WHERE ph.program_id = t.program_id AND ph.user_id = e.actor_id)
   ORDER BY e.created_at DESC, e.id DESC LIMIT 1),
  t.assignee_id,
  t.resolved_by
)`;

function programTotals(programId, { since } = {}) {
  const cutoff = sinceValue(since);
  const h = db.handle();
  const counts = h.query(
    `SELECT
       COUNT(*) AS created,
       SUM(CASE WHEN status IN (${OPEN_SQL}) THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status = 'waiting_for_helper' THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
       SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
       SUM(CASE WHEN COALESCE(reopen_count, 0) > 0 THEN 1 ELSE 0 END) AS reopened
     FROM tickets WHERE program_id = ? AND created_at >= ?`,
  ).get(...OPEN_STATUSES, programId, cutoff);
  const resolvedInWindow = h.query(
    `SELECT COUNT(*) AS n FROM tickets
     WHERE program_id = ? AND status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at >= ?`,
  ).get(programId, cutoff).n;
  const times = h.query(
    `SELECT created_at, first_response_at, first_human_response_at, resolved_at, status
     FROM tickets WHERE program_id = ? AND created_at >= ?`,
  ).all(programId, cutoff);
  const resolutionTimes = h.query(
    "SELECT created_at, resolved_at FROM tickets WHERE program_id = ? AND status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at >= ?",
  ).all(programId, cutoff);
  const lag = (field, rows = times) => rows
    .filter((row) => row[field] !== null && row[field] !== undefined)
    .map((row) => row[field] - row.created_at);

  const values = (row) => Number(row || 0);
  return {
    programId,
    since: cutoff,
    created: values(counts.created),
    open: values(counts.open),
    waiting: values(counts.waiting),
    resolved: values(counts.resolved),
    resolvedInWindow: Number(resolvedInWindow || 0),
    closed: values(counts.closed),
    reopened: values(counts.reopened),
    medianFirstResponseMs: median(lag("first_response_at")),
    medianHumanResponseMs: median(lag("first_human_response_at")),
    medianResolveMs: median(resolutionTimes.map((row) => row.resolved_at - row.created_at)),
  };
}

function helperTotals(programId, userId, { since } = {}) {
  const cutoff = sinceValue(since);
  const h = db.handle();
  const creditedWhere = `${CREDIT_SQL} = ?`;
  const resolved = h.query(
    `SELECT t.id, t.category, t.created_at, t.resolved_at, t.reopen_count
     FROM tickets t WHERE t.program_id = ? AND t.status = 'resolved'
       AND t.resolved_at IS NOT NULL AND t.resolved_at >= ? AND ${creditedWhere}`,
  ).all(programId, cutoff, userId);
  const open = h.query(
    `SELECT COUNT(*) AS n FROM tickets
     WHERE program_id = ? AND assignee_id = ? AND status IN (${OPEN_SQL}) AND created_at >= ?`,
  ).get(programId, userId, ...OPEN_STATUSES, cutoff).n;
  const replies = h.query(
    `SELECT e.ticket_id, e.created_at AS at, t.created_at
     FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id AND t.program_id = e.program_id
     WHERE e.program_id = ? AND e.actor_id = ? AND e.event_type = 'helper_reply'
       AND e.created_at >= ? ORDER BY e.created_at ASC, e.id ASC`,
  ).all(programId, userId, cutoff);
  const assigned = h.query(
    `SELECT COUNT(DISTINCT ticket_id) AS n FROM ticket_events
     WHERE program_id = ? AND created_at >= ? AND
       ((event_type = 'claimed' AND actor_id = ?) OR
        (event_type = 'assigned' AND detail LIKE ?))`,
  ).get(programId, cutoff, userId, `%"to":"${String(userId).replace(/"/g, "\\\"")}"%`).n;
  const reopenCount = resolved.filter((row) => Number(row.reopen_count || 0) > 0).length;
  const categoryResolved = new Map();
  const firstReplyAt = new Map();
  for (const reply of replies) if (!firstReplyAt.has(reply.ticket_id)) firstReplyAt.set(reply.ticket_id, reply.at - reply.created_at);
  for (const row of resolved) {
    const category = row.category || "general";
    categoryResolved.set(category, (categoryResolved.get(category) || 0) + 1);
  }
  return {
    programId,
    userId,
    since: cutoff,
    resolved: resolved.length,
    open: Number(open || 0),
    replies: replies.length,
    assigned: Number(assigned || 0),
    reopened: reopenCount,
    reopenRate: rate(reopenCount, resolved.length),
    medianFirstResponseMs: median([...firstReplyAt.values()]),
    medianResolutionMs: median(resolved.map((row) => row.resolved_at - row.created_at)),
    categoryResolved: [...categoryResolved.entries()].map(([category, count]) => ({ category, resolved: count })),
  };
}

function leaderboard(programId, { since } = {}) {
  const cutoff = sinceValue(since);
  const helperRows = db.listHelpers(programId, false);
  const credited = db.handle().query(
    `SELECT DISTINCT ${CREDIT_SQL} AS userId FROM tickets t
     WHERE t.program_id = ? AND t.status = 'resolved' AND t.resolved_at IS NOT NULL
       AND t.resolved_at >= ? AND ${CREDIT_SQL} IS NOT NULL`,
  ).all(programId, cutoff).map((row) => row.userId).filter(Boolean);
  const known = new Map(helperRows.map((helper) => [helper.user_id, helper]));
  for (const userId of credited) if (!known.has(userId)) known.set(userId, { user_id: userId, role: "helper", active: 0 });
  return [...known.values()].map((helper) => {
    const totals = helperTotals(programId, helper.user_id, { since: cutoff });
    return {
      userId: helper.user_id,
      role: helper.role,
      active: Boolean(helper.active),
      resolved: totals.resolved,
      replies: totals.replies,
      open: totals.open,
      reopened: totals.reopened,
      reopenRate: totals.reopenRate,
      points: totals.resolved,
    };
  }).sort((a, b) => b.resolved - a.resolved || b.replies - a.replies || a.userId.localeCompare(b.userId));
}

module.exports = { OPEN_STATUSES, programTotals, helperTotals, leaderboard, median, rate, CREDIT_SQL };
