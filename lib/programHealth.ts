const supportAnalytics = require("./supportAnalytics");
const db = require("./db");

const SCORE_VERSION = 1;
const MIN_QUESTIONS_FOR_SCORE = 5;
const OPEN_STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];

type Analytics = { byStatus: Record<string, number>; stale48h: number; created: number; reopenRate: number; windowDays: number };
type SourceHealth = { name: string; fail_count: number };
interface SourceRef { name: string; type?: string; url?: string }
interface GapCluster { covered: boolean }
interface HealthComponents { ticketBacklog: number; sourceHealth: number; knowledgeCoverage: number; resolutionQuality: number }
interface HealthScore { error?: string; programId?: string; version?: number; score?: number | null; label?: string | null; components?: HealthComponents | null; windowDays?: number; questionsInWindow?: number }

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function ticketBacklogComponent(analytics: Analytics): number {
  const open = OPEN_STATUSES.reduce((sum, status) => sum + (analytics.byStatus[status] || 0), 0);
  if (open === 0) return 100;
  return clamp(100 - (analytics.stale48h / open) * 100);
}

function sourceHealthComponent(programId: string): number {
  const programs = require("./programs");
  const knowledge = require("./knowledge");
  const prog = programs.get(programId);
  const sources = prog && Array.isArray(prog.sources) ? prog.sources : [];
  if (sources.length === 0) return 100;
  const keyed = sources.map((s: SourceRef) => knowledge.sourceCacheKey(s) || s.name).filter(Boolean) as string[];
  const health = db.getSourceHealth(keyed);
  const byKey = new Map((health as SourceHealth[]).map((h) => [h.name, h]));
  const scores = keyed.map((key: string) => {
    const h = byKey.get(key);
    if (!h || !h.fail_count) return 100;
    return clamp(100 - h.fail_count * 20);
  });
  return clamp(scores.reduce((sum, s) => sum + s, 0) / scores.length);
}

function knowledgeCoverageComponent(programId: string): number {
  const gapClusters = require("./gapClusters");
  const { clusters, error } = gapClusters.clusterGaps({ programId, sinceMs: 30 * 24 * 60 * 60 * 1000, minAskers: 2 });
  if (error || !clusters || clusters.length === 0) return 100;
  const covered = clusters.filter((c: GapCluster) => c.covered).length;
  return clamp((covered / clusters.length) * 100);
}

function resolutionQualityComponent(analytics: Analytics): number {
  const escalationRate = analytics.created > 0 ? (analytics.byStatus.escalated || 0) / analytics.created : 0;
  return clamp(100 - analytics.reopenRate * 150 - escalationRate * 50);
}

function computeHealthScore(programId: string, { sinceMs = 30 * 24 * 60 * 60 * 1000 }: { sinceMs?: number } = {}): HealthScore {
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

export = { computeHealthScore, SCORE_VERSION, MIN_QUESTIONS_FOR_SCORE };
