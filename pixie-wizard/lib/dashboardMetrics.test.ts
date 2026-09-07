import { describe, expect, test } from "bun:test";
import { summarizeAnalytics } from "./dashboardMetrics";

describe("summarizeAnalytics", () => {
  test("aggregates only authoritative per-program analytics", () => {
    expect(summarizeAnalytics([{
      programId: "a", created: 8, aiAnswered: 5, humanHandled: 2, stale48h: 1,
      byStatus: { resolved: 3, open: 2, escalated: 1 }, gapCounts: { unanswered: 2 }, incidents: { active: 1, resolved: 2 },
      medianFirstResponseMs: 1000, medianResolveMs: 2000,
    }, {
      programId: "b", created: 4, aiAnswered: 4, humanHandled: 0, stale48h: 0,
      byStatus: { resolved: 1, claimed: 1 }, gapCounts: {}, incidents: {},
      medianFirstResponseMs: null, medianResolveMs: null,
    }])).toEqual({ questions: 12, aiAnswered: 9, escalated: 1, openTickets: 4, resolved: 4, stale: 1, faqGaps: 2, activeIncidents: 1 });
  });
});
