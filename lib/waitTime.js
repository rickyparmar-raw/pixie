// Wait-time estimation from real support history. Medians over recent
// resolved tickets, never model-invented numbers. Small samples return
// unavailable with a labeled fallback instead of fake precision.
const db = require("./db");

// Only the last week counts: older lags describe a different staffing reality.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Fewer than 5 same-category samples is noise — fall back to the program median.
const MIN_CATEGORY_SAMPLE = 5;
// Fewer than 3 program samples is still a guess — admit it instead.
const MIN_PROGRAM_SAMPLE = 3;
// Window label echoes WINDOW_MS so the UI never drifts from the query.
const WINDOW_DAYS = 7;
// Queue counts only live states: resolved/closed tickets are not ahead of anyone.
const QUEUE_STATUSES = ["open", "waiting_for_helper", "escalated", "reopened"];
const MS_PER_MINUTE = 60000;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function isUsableLag(n) {
  return Number.isFinite(n) && n >= 0;
}

function responseLags(programId, category = null, sinceMs = WINDOW_MS) {
  const cutoff = Date.now() - sinceMs;
  const params = [programId, cutoff];
  if (category) params.push(category);
  const rows = db.handle().query(
    `SELECT (first_human_response_at - created_at) AS lag FROM tickets
     WHERE program_id = ? AND created_at > ? AND first_human_response_at IS NOT NULL ${category ? "AND category = ?" : ""}`,
  ).all(...params);
  return rows.map((r) => r.lag).filter(isUsableLag);
}

function queuePosition(programId, ticketId, category = null) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return null;
  const placeholders = QUEUE_STATUSES.map(() => "?").join(",");
  const categoryClause = category ? " AND category = ?" : "";
  const params = [programId, ...QUEUE_STATUSES, ticket.created_at, ticket.created_at, ticketId];
  if (category) params.push(category);
  const row = db.handle().query(
    `SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND status IN (${placeholders})
     AND (created_at < ? OR (created_at = ? AND id < ?))${categoryClause}`,
  ).get(...params);
  if (!row) return 0;
  return row.n;
}

function queueDepth(programId, category = null) {
  const placeholders = QUEUE_STATUSES.map(() => "?").join(",");
  const categoryClause = category ? " AND category = ?" : "";
  const params = [programId, ...QUEUE_STATUSES];
  if (category) params.push(category);
  const row = db.handle().query(
    `SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND status IN (${placeholders})${categoryClause}`,
  ).get(...params);
  return row ? row.n : 0;
}

function lagsFor(programId, category) {
  if (!category) return { lags: [], scope: "category" };
  return { lags: responseLags(programId, category), scope: "category" };
}

function estimate({ programId, category = null, ticketId = null }) {
  if (!programId) return { error: "programId required" };
  let { lags, scope } = lagsFor(programId, category);
  if (lags.length < MIN_CATEGORY_SAMPLE) {
    lags = responseLags(programId, null);
    scope = "program";
  }
  if (lags.length < MIN_PROGRAM_SAMPLE) {
    return { available: false, reason: "insufficient history", sampleSize: lags.length, scope };
  }
  return {
    available: true,
    medianWaitMs: median(lags),
    sampleSize: lags.length,
    scope,
    windowDays: WINDOW_DAYS,
    queueAhead: ticketId ? queuePosition(programId, ticketId, category) : null,
  };
}

function formatWait(estimateResult) {
  if (!estimateResult || !estimateResult.available) return null;
  const mins = Math.round(estimateResult.medianWaitMs / MS_PER_MINUTE);
  if (mins < 1) return "usually under a minute";
  if (mins < 60) return `usually around ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `usually around ${hours} hour${hours === 1 ? "" : "s"}`;
}

module.exports = { estimate, formatWait, median, responseLags, queueDepth, queuePosition };
