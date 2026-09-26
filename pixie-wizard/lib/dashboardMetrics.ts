// Zero-filled daily row; aiOnly and human are disjoint.
export type VolumeDay = {
  date: string;
  questions: number;
  aiOnly: number;
  human: number;
};

export type AnalyticsSnapshot = {
  programId: string;
  daily?: VolumeDay[];
  created: number;
  aiAnswered: number;
  humanHandled: number;
  stale48h: number;
  byStatus: Record<string, number>;
  gapCounts: Record<string, number>;
  incidents: Record<string, number>;
  medianFirstResponseMs: number | null;
  medianResolveMs: number | null;
  resolvedToday?: number;
  openCount?: number;
  waitingCount?: number;
};

export type DashboardTotals = {
  questions: number;
  aiAnswered: number;
  escalated: number;
  openTickets: number;
  resolved: number;
  stale: number;
  faqGaps: number;
  activeIncidents: number;
  waitingTickets: number;
  resolvedToday: number | null;
};

export const OPEN_STATUSES = ["open", "waiting_for_helper", "escalated", "assigned", "claimed", "reopened"] as const;

export function summarizeAnalytics(rows: readonly AnalyticsSnapshot[]): DashboardTotals {
  return rows.reduce<DashboardTotals>((totals, row) => {
    const resolved = row.byStatus.resolved ?? 0;
    const escalated = row.byStatus.escalated ?? 0;
    const openTickets = typeof row.openCount === "number"
      ? row.openCount
      : OPEN_STATUSES.reduce((sum, status) => sum + (row.byStatus[status] ?? 0), 0);
    const faqGaps = Object.values(row.gapCounts).reduce((sum, count) => sum + count, 0);
    const activeIncidents = Object.entries(row.incidents)
      .filter(([status]) => status !== "resolved")
      .reduce((sum, [, count]) => sum + count, 0);
    const resolvedToday = typeof row.resolvedToday === "number" ? row.resolvedToday : null;
    return {
      questions: totals.questions + row.created,
      aiAnswered: totals.aiAnswered + row.aiAnswered,
      escalated: totals.escalated + escalated,
      openTickets: totals.openTickets + openTickets,
      resolved: totals.resolved + resolved,
      stale: totals.stale + row.stale48h,
      faqGaps: totals.faqGaps + faqGaps,
      activeIncidents: totals.activeIncidents + activeIncidents,
      waitingTickets: totals.waitingTickets + (typeof row.waitingCount === "number" ? row.waitingCount : (row.byStatus.waiting_for_helper ?? 0)),
      resolvedToday: totals.resolvedToday === null || resolvedToday === null ? null : totals.resolvedToday + resolvedToday,
    };
  }, { questions: 0, aiAnswered: 0, escalated: 0, openTickets: 0, resolved: 0, stale: 0, faqGaps: 0, activeIncidents: 0, waitingTickets: 0, resolvedToday: 0 });
}

// Statuses with a ticket still in someone's queue — the "Open" filter group
// in the tickets list and the openTickets count share this set with Core's
// OPEN_GROUP (lib/web/dashboardApi.js); keep them byte-identical.
export const OPEN_STATUSES_DASHBOARD: readonly string[] = OPEN_STATUSES;

export function isOpenTicketStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && OPEN_STATUSES_DASHBOARD.includes(status);
}

// Waiting time for display/sort: resolved tickets waited until resolution,
// open ones are still waiting. Never negative (clock skew), null when the
// row carries no usable timestamps.
export function waitingMs(
  ticket: { created_at?: unknown; resolved_at?: unknown; updated_at?: unknown },
  now = Date.now(),
): number | null {
  const created = typeof ticket.created_at === "number" ? ticket.created_at : null;
  if (created === null || !Number.isFinite(created)) return null;
  const end = typeof ticket.resolved_at === "number" ? ticket.resolved_at : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - created);
}

// Deep link into the Slack thread a ticket came from. slack.com/archives
// resolves the workspace itself, so Core never has to expose which
// workspace a channel lives in for the dashboard to link it.
export function slackThreadUrl(channel: string | null | undefined, threadTs: string | null | undefined): string | null {
  if (!channel || !threadTs || !/^[A-Za-z0-9_-]+$/.test(channel)) return null;
  const compact = String(threadTs).replace(".", "");
  if (!/^\d+$/.test(compact)) return null;
  return `https://slack.com/archives/${channel}/p${compact}`;
}

// Merge by date, not by index.
export function mergeDailySeries(rows: readonly AnalyticsSnapshot[]): VolumeDay[] {
  const byDate = new Map<string, VolumeDay>();
  for (const row of rows) {
    for (const day of row.daily ?? []) {
      const merged = byDate.get(day.date) ?? { date: day.date, questions: 0, aiOnly: 0, human: 0 };
      merged.questions += day.questions;
      merged.aiOnly += day.aiOnly;
      merged.human += day.human;
      byDate.set(day.date, merged);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
