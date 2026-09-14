import { describe, expect, test } from "bun:test";
import { mergeDailySeries, summarizeAnalytics } from "./dashboardMetrics";

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

describe("mergeDailySeries", () => {
  const base = {
    created: 0, aiAnswered: 0, humanHandled: 0, stale48h: 0,
    byStatus: {}, gapCounts: {}, incidents: {},
    medianFirstResponseMs: null, medianResolveMs: null,
  };

  test("sums matching dates and keeps the timeline ordered", () => {
    expect(mergeDailySeries([
      { ...base, programId: "a", daily: [
        { date: "2026-09-01", questions: 3, aiOnly: 2, human: 1 },
        { date: "2026-09-02", questions: 5, aiOnly: 5, human: 0 },
      ] },
      // Activated a day late — its series starts inside the window.
      { ...base, programId: "b", daily: [
        { date: "2026-09-02", questions: 4, aiOnly: 1, human: 3 },
      ] },
    ])).toEqual([
      { date: "2026-09-01", questions: 3, aiOnly: 2, human: 1 },
      { date: "2026-09-02", questions: 9, aiOnly: 6, human: 3 },
    ]);
  });

  test("returns an empty timeline when no program reports one", () => {
    expect(mergeDailySeries([{ ...base, programId: "a" }])).toEqual([]);
  });
});
