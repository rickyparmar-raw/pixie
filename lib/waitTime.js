// Wait-time estimation from real support history. Medians over recent
// resolved tickets, never model-invented numbers. Small samples return
// unavailable with a labeled fallback instead of fake precision.
const db = require("./db");

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CATEGORY_SAMPLE = 5;
const MIN_PROGRAM_SAMPLE = 3;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function responseLags(programId, category = null, sinceMs = WINDOW_MS) {
  const cutoff = Date.now() - sinceMs;
  const params = [programId, cutoff];
  let categoryClause = "";
  if (category) {
    categoryClause = "AND category = ?";
    params.push(category);
  }
  const rows = db.handle().query(
    `SELECT (first_human_response_at - created_at) AS lag FROM tickets
     WHERE program_id = ? AND created_at > ? AND first_human_response_at IS NOT NULL ${categoryClause}`,
  ).all(...params);
  return rows.map((r) => r.lag).filter((n) => Number.isFinite(n) && n >= 0);
}

function queuePosition(programId, ticketId) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return null;
  const row = db.handle().query(
    `SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND status IN ('open','waiting_for_helper','escalated','reopened')
     AND created_at < ? AND id != ?`,
  ).get(programId, ticket.created_at, ticketId);
  return row ? row.n : 0;
}

function estimate({ programId, category = null, ticketId = null }) {
  if (!programId) return { error: "programId required" };
  let lags = category ? responseLags(programId, category) : [];
  let scope = "category";
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
    windowDays: 7,
    queueAhead: ticketId ? queuePosition(programId, ticketId) : null,
  };
}

function formatWait(estimateResult) {
  if (!estimateResult || !estimateResult.available) return null;
  const mins = Math.round(estimateResult.medianWaitMs / 60000);
  if (mins < 1) return "usually under a minute";
  if (mins < 60) return `usually around ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `usually around ${hours} hour${hours === 1 ? "" : "s"}`;
}

module.exports = { estimate, formatWait, median, responseLags };
