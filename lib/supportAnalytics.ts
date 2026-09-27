import db = require("./db");
import ticketMetrics = require("./ticketMetrics");

interface AnalyticsRow {
  created_at: number;
  first_human_response_at?: number | null;
  first_response_at?: number | null;
  reopen_count?: number | null;
  status?: string;
  n?: number;
  category?: string;
  userId?: string;
  openAssigned?: number;
  kind?: string;
  [key: string]: unknown;
}

interface DailyPoint {
  date: string;
  questions: number;
  aiOnly: number;
  human: number;
}

interface SupportOverview {
  programId: string;
  windowDays: number;
  created: number;
  byStatus: Record<string, number>;
  openCount: number;
  waitingCount: number;
  resolvedToday: number;
  resolved: number;
  resolvedInWindow: number;
  reopened: number;
  reopenRate: number;
  duplicates: number;
  duplicateRate: number;
  aiAnswered: number;
  humanHandled: number;
  deflected: number;
  deflectionRate: number;
  medianFirstResponseMs: number | null;
  medianFirstHumanResponseMs: number | null;
  medianResolveMs: number | null;
  byCategory: AnalyticsRow[];
  daily: DailyPoint[];
  helperLoad: AnalyticsRow[];
  helperResolved: Array<{ userId: string; resolved: number }>;
  stale48h: number;
  gapCounts: unknown;
  incidents: Record<string, number>;
  activityKinds: Record<string, number>;
}

const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000;
const STALE48H_MS = 48 * 60 * 60 * 1000;
const STALE48H_STATUSES = ["open", "waiting_for_helper", "escalated", "reopened"];
const OPEN_STATUSES = Object.freeze(["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"]);
const GAP_COUNTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function median(values: number[]): number | null {
  const sorted = [...values].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function lags(rows: AnalyticsRow[], from: string, to: string): number[] {
  return rows.map((r) => Number(r[to]) - Number(r[from])).filter((n) => Number.isFinite(n) && n >= 0);
}

function rate(n: number, d: number): number {
  return d > 0 ? Number((n / d).toFixed(3)) : 0;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dailySeries(rows: AnalyticsRow[], cutoff: number, now: number): DailyPoint[] {
  const days = new Map<string, DailyPoint>();
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

function overview(programId: string, sinceMs = DEFAULT_SINCE_MS): SupportOverview {
  const now = Date.now();
  const cutoff = now - sinceMs;
  const totals = ticketMetrics.programTotals(programId, { since: cutoff });
  const byStatus = db
    .handle()
    .query("SELECT status, COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ? GROUP BY status")
    .all(programId, cutoff) as AnalyticsRow[];
  const counts: Record<string, number> = Object.fromEntries(byStatus.map((r) => [r.status || "", Number(r.n || 0)]));
  counts.resolved = totals.resolvedInWindow;
  const created = byStatus.reduce((n, r) => n + Number(r.n || 0), 0);
  const openCount = OPEN_STATUSES.reduce((n, status) => n + (counts[status] || 0), 0);
  const waitingCount = counts.waiting_for_helper || 0;

  const resolvedToday = ticketMetrics.programTotals(programId, {
    since: Date.parse(`${utcDay(now)}T00:00:00Z`),
  }).resolvedInWindow;

  const times = db
    .handle()
    .query(
      "SELECT created_at, first_response_at, first_human_response_at, resolved_at, reopen_count, status FROM tickets WHERE program_id = ? AND created_at > ?",
    )
    .all(programId, cutoff) as AnalyticsRow[];

  const resolved = db
    .handle()
    .query(
      "SELECT first_human_response_at FROM tickets WHERE program_id = ? AND status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at >= ?",
    )
    .all(programId, cutoff) as AnalyticsRow[];
  const reopened = times.filter((t) => (t.reopen_count || 0) > 0).length;
  const aiAnswered = times.filter((t) => t.first_response_at).length;
  const humanHandled = times.filter((t) => t.first_human_response_at).length;
  const deflected = resolved.filter((t) => !t.first_human_response_at).length;

  const byCategory = db
    .handle()
    .query(
      "SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ? GROUP BY category ORDER BY n DESC",
    )
    .all(programId, cutoff) as AnalyticsRow[];

  const helperLoad = db
    .handle()
    .query(
      `SELECT assignee_id AS userId, COUNT(*) AS openAssigned FROM tickets
     WHERE program_id = ? AND assignee_id IS NOT NULL AND created_at > ? AND status IN ('claimed','assigned','waiting_for_helper','escalated','reopened')
     GROUP BY assignee_id`,
    )
    .all(programId, cutoff) as AnalyticsRow[];

  const helperResolved = ticketMetrics
    .leaderboard(programId, { since: cutoff })
    .filter((helper) => helper.resolved > 0)
    .map((helper) => ({ userId: helper.userId, resolved: helper.resolved }));

  const stale = db
    .handle()
    .query(
      `SELECT COUNT(*) AS n FROM tickets WHERE program_id = ?
     AND status IN (${STALE48H_STATUSES.map(() => "?").join(",")})
     AND created_at > ? AND created_at < ?`,
    )
    .get(programId, ...STALE48H_STATUSES, cutoff, now - STALE48H_MS) as AnalyticsRow;

  const duplicates = counts.duplicate || 0;
  const gapCounts = (db.gapCountsByKind as (windowMs: number, kind: null, programId: string) => unknown)(
    GAP_COUNTS_WINDOW_MS,
    null,
    programId,
  );
  const incidents = db
    .handle()
    .query("SELECT status, COUNT(*) AS n FROM program_incidents WHERE program_id = ? GROUP BY status")
    .all(programId) as AnalyticsRow[];

  const kinds = db
    .handle()
    .query(
      "SELECT kind, COUNT(*) AS n FROM metrics WHERE (program_id = ? OR program_id IS NULL) AND created_at > ? GROUP BY kind",
    )
    .all(programId, cutoff) as AnalyticsRow[];

  return {
    programId,
    windowDays: Math.round(sinceMs / 86400000),
    created,
    byStatus: counts,
    openCount,
    waitingCount,
    resolvedToday,
    resolved: totals.resolved,
    resolvedInWindow: totals.resolvedInWindow,
    reopened,
    reopenRate: rate(reopened, created),
    duplicates,
    duplicateRate: rate(duplicates, created),
    aiAnswered,
    humanHandled,
    deflected,
    deflectionRate: rate(deflected, resolved.length),
    medianFirstResponseMs: totals.medianFirstResponseMs,
    medianFirstHumanResponseMs: totals.medianHumanResponseMs,
    medianResolveMs: totals.medianResolveMs,
    byCategory,
    daily: dailySeries(times, cutoff, now),
    helperLoad,
    helperResolved,
    stale48h: Number(stale.n || 0),
    gapCounts,
    incidents: Object.fromEntries(incidents.map((r) => [r.status, r.n])),
    activityKinds: Object.fromEntries(kinds.map((r) => [r.kind, r.n])),
  };
}

export = { overview, median, OPEN_STATUSES };
