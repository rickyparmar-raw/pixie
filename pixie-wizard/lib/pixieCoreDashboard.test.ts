import { afterEach, expect, mock, test } from "bun:test";
import {
  coreDashboardMetrics,
  coreDashboardTicketDetail,
  coreDashboardTicketSearch,
  coreHelperRoster,
  coreHelperSetActive,
  coreKnowledgeRefresh,
  coreKnowledgeStatus,
} from "./pixieCore";

afterEach(() => {
  mock.restore();
  delete process.env.PIXIE_CORE_BASE_URL;
  delete process.env.PIXIE_INTERNAL_TOKEN;
});

function configured() {
  process.env.PIXIE_CORE_BASE_URL = "https://core.example";
  process.env.PIXIE_INTERNAL_TOKEN = "secret";
}

function ok(body: unknown) {
  return mock(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;
}

test("dashboard ticket search is program-scoped in the path and drops empty params", async () => {
  configured();
  const fetchMock = ok({ total: 0, rows: [] });
  globalThis.fetch = fetchMock;
  await coreDashboardTicketSearch("program/a", { statusGroup: "open", sort: "waiting", q: "", limit: "25" });
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toContain("/programs/program%2Fa/tickets/search?");
  expect(url).toContain("statusGroup=open");
  expect(url).toContain("sort=waiting");
  expect(url).not.toContain("q=");
});

test("dashboard ticket detail addresses the tenant row, never the bare id", async () => {
  configured();
  const fetchMock = ok({ ticket: { id: 7 } });
  globalThis.fetch = fetchMock;
  await coreDashboardTicketDetail("program/a", 7);
  expect(String(fetchMock.mock.calls[0][0])).toContain("/programs/program%2Fa/tickets/7");
});

test("dashboard metrics, knowledge and roster hit their program routes", async () => {
  configured();
  globalThis.fetch = ok({}) as typeof fetch;
  const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
  await coreDashboardMetrics("program/a", 7);
  expect(String(fetchMock.mock.calls[0][0])).toContain("/programs/program%2Fa/dashboard/metrics?days=7");
  await coreKnowledgeStatus("program/a");
  expect(String(fetchMock.mock.calls[1][0])).toContain("/programs/program%2Fa/knowledge/status");
  await coreHelperRoster("program/a");
  expect(String(fetchMock.mock.calls[2][0])).toContain("/programs/program%2Fa/helpers/roster");
});

test("knowledge refresh and helper availability send bodies, not query strings", async () => {
  configured();
  const fetchMock = ok({ started: true });
  globalThis.fetch = fetchMock;
  await coreKnowledgeRefresh("program/a");
  const [refreshUrl, refreshInit] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(refreshUrl).toContain("/programs/program%2Fa/knowledge/refresh");
  expect(refreshInit.method).toBe("POST");

  await coreHelperSetActive("program/a", { userId: "U1", active: false, actorId: "U2" });
  const [activeUrl, activeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(activeUrl).toContain("/programs/program%2Fa/helpers/active");
  expect(activeInit.method).toBe("PATCH");
  expect(String(activeInit.body)).toContain("U1");
});

test("dashboard clients surface Core errors instead of swallowing them", async () => {
  configured();
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ error: "ticket not found" }), { status: 404 })),
  ) as typeof fetch;
  await expect(coreDashboardTicketDetail("program/a", 1)).rejects.toThrow("ticket not found");
});
