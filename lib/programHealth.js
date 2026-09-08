// Deterministic Program Support Health score. No LLM, no invented precision:
// every component is a plain ratio of stored counts, clamped to [0, 100], and
// a program without enough recent activity reports "not enough data" rather
// than a fake 100%.
//
// SCORE_VERSION exists so a future change to the formula can be told apart
// from an actual change in program health when reading historical scores.
const supportAnalytics = require("./supportAnalytics");
const db = require("./db");

const SCORE_VERSION = 1;
const MIN_QUESTIONS_FOR_SCORE = 5;
const OPEN_STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function ticketBacklogComponent(analytics) {
  const open = OPEN_STATUSES.reduce((sum, status) => sum + (analytics.byStatus[status] || 0), 0);
  if (open === 0) return 100;
  return clamp(100 - (analytics.stale48h / open) * 100);
}

function sourceHealthComponent(programId) {
  const programs = require("./programs");
  const knowledge = require("./knowledge");
  const prog = programs.get(programId);
  const sources = prog && Array.isArray(prog.sources) ? prog.sources : [];
  if (sources.length === 0) return 100;
  const keyed = sources.map((s) => knowledge.sourceCacheKey(s) || s.name).filter(Boolean);
  const health = db.getSourceHealth(keyed);
  const byKey = new Map(health.map((h) => [h.name, h]));
  const scores = keyed.map((key) => {
    const h = byKey.get(key);
    if (!h || !h.fail_count) return 100;
    return clamp(100 - h.fail_count * 20);
  });
  return clamp(scores.reduce((sum, s) => sum + s, 0) / scores.length);
}

function knowledgeCoverageComponent(programId) {
  const gapClusters = require("./gapClusters");
  const { clusters, error } = gapClusters.clusterGaps({ programId, sinceMs: 30 * 24 * 60 * 60 * 1000, minAskers: 2 });
  if (error || !clusters || clusters.length === 0) return 100;
  const covered = clusters.filter((c) => c.covered).length;
  return clamp((covered / clusters.length) * 100);
}

// Reopens double-count against quality (a reopen means the first resolution
// failed the requester); escalations count once, since routing to a human is
// often the correct outcome, not a defect.
function resolutionQualityComponent(analytics) {
  const escalationRate = analytics.created > 0 ? (analytics.byStatus.escalated || 0) / analytics.created : 0;
  return clamp(100 - analytics.reopenRate * 150 - escalationRate * 50);
}

function computeHealthScore(programId, { sinceMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  if (!programId) return { error: "programId required" };
  const analytics = supportAnalytics.overview(programId, sinceMs);
  if (analytics.created < MIN_QUESTIONS_FOR_SCORE) {
    return {
      programId,
      version: SCORE_VERSION,
      score: null,
      label: "Not enough data",
      components: null,
      windowDays: analytics.windowDays,
      questionsInWindow: analytics.created,
    };
  }
  const components = {
    ticketBacklog: ticketBacklogComponent(analytics),
    sourceHealth: sourceHealthComponent(programId),
    knowledgeCoverage: knowledgeCoverageComponent(programId),
    resolutionQuality: resolutionQualityComponent(analytics),
  };
  const score = clamp(Object.values(components).reduce((sum, v) => sum + v, 0) / Object.keys(components).length);
  return { programId, version: SCORE_VERSION, score, label: null, components, windowDays: analytics.windowDays, questionsInWindow: analytics.created };
}

module.exports = { computeHealthScore, SCORE_VERSION, MIN_QUESTIONS_FOR_SCORE };
