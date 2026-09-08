// Per-user throttle. Nothing bounded pixie's API spend before this — one
// person pasting in a loop could drain the budget for the whole channel.
const db = require("./db");

// Generous enough that no real conversation trips it, tight enough that a
// script can't.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.PIXIE_RATE_LIMIT_MAX) || 8;

const ALLOW = { allowed: true, retryInMs: 0 };

// Pure verdict so the counting path stays a straight line: over budget denies
// without recording (a denied check must not itself consume budget), under
// budget records exactly once.
function check(userId, { windowMs = WINDOW_MS, max = MAX_PER_WINDOW } = {}) {
  if (!userId) return ALLOW;
  if (db.countRecentRequests(userId, windowMs) >= max) return { allowed: false, retryInMs: windowMs };
  db.recordRequest(userId);
  return ALLOW;
}

module.exports = { check, WINDOW_MS, MAX_PER_WINDOW };
