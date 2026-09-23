import { describe, expect, test } from "bun:test";
import { isOpenTicketStatus, mergeDailySeries, slackThreadUrl, summarizeAnalytics, waitingMs } from "./dashboardMetrics";

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

describe("isOpenTicketStatus", () => {
  test("matches Core's OPEN_GROUP working set", () => {
    for (const status of ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"]) {
      expect(isOpenTicketStatus(status)).toBe(true);
    }
    for (const status of ["resolved", "closed", "duplicate", "snoozed", null, undefined, ""]) {
      expect(isOpenTicketStatus(status as string)).toBe(false);
    }
  });
});

describe("waitingMs", () => {
  test("open tickets wait until now, resolved tickets until resolution", () => {
    expect(waitingMs({ created_at: 1000, resolved_at: null }, 6000)).toBe(5000);
    expect(waitingMs({ created_at: 1000, resolved_at: 3000 }, 9000)).toBe(2000);
  });

  test("clamps skew and rejects unusable rows", () => {
    expect(waitingMs({ created_at: 5000, resolved_at: 1000 }, 9000)).toBe(0);
    expect(waitingMs({ created_at: null }, 9000)).toBeNull();
    expect(waitingMs({}, 9000)).toBeNull();
  });
});

describe("slackThreadUrl", () => {
  test("builds a workspace-agnostic thread permalink", () => {
    expect(slackThreadUrl("C012345", "1700000000.123456")).toBe(
      "https://slack.com/archives/C012345/p1700000000123456",
    );
  });

  test("rejects malformed channel and timestamp inputs", () => {
    expect(slackThreadUrl("../x", "1700000000.1")).toBeNull();
    expect(slackThreadUrl("C012345", "not-a-ts")).toBeNull();
    expect(slackThreadUrl(null, "1700000000.1")).toBeNull();
  });
});
