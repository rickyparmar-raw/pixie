// One row per day of the analytics window, zero-filled by Core. `aiOnly` and
// `human` are disjoint slices of `questions`; the remainder is still waiting
// on a first reply.
export type VolumeDay = {
  date: string;
  questions: number;
  aiOnly: number;
  human: number;
};

export type AnalyticsSnapshot = {
  programId: string;
  created: number;
  aiAnswered: number;
  humanHandled: number;
  stale48h: number;
  byStatus: Record<string, number>;
  gapCounts: Record<string, number>;
  incidents: Record<string, number>;
  medianFirstResponseMs: number | null;
  medianResolveMs: number | null;
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
};

const OPEN_STATUSES = ["open", "waiting_for_helper", "escalated", "assigned", "claimed", "reopened"];

export function summarizeAnalytics(rows: readonly AnalyticsSnapshot[]): DashboardTotals {
  return rows.reduce<DashboardTotals>((totals, row) => {
    const resolved = row.byStatus.resolved ?? 0;
    const escalated = row.byStatus.escalated ?? 0;
    const openTickets = OPEN_STATUSES.reduce((sum, status) => sum + (row.byStatus[status] ?? 0), 0);
    const faqGaps = Object.values(row.gapCounts).reduce((sum, count) => sum + count, 0);
    const activeIncidents = Object.entries(row.incidents)
      .filter(([status]) => status !== "resolved")
      .reduce((sum, [, count]) => sum + count, 0);
    return {
      questions: totals.questions + row.created,
      aiAnswered: totals.aiAnswered + row.aiAnswered,
      escalated: totals.escalated + escalated,
      openTickets: totals.openTickets + openTickets,
      resolved: totals.resolved + resolved,
      stale: totals.stale + row.stale48h,
      faqGaps: totals.faqGaps + faqGaps,
      activeIncidents: totals.activeIncidents + activeIncidents,
    };
  }, { questions: 0, aiAnswered: 0, escalated: 0, openTickets: 0, resolved: 0, stale: 0, faqGaps: 0, activeIncidents: 0 });
}
