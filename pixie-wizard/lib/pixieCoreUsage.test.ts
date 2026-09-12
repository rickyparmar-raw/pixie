import { afterEach, expect, mock, test } from "bun:test";
import { coreUsage } from "./pixieCore";

const metric = { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costCents: null };
const response = (programId: string, from = "2026-01-01T00:00:00Z", to = "2026-01-02T00:00:00Z") => ({
  programId, from, to, ...metric, precision: "unavailable", summary: metric,
  timeseries: [], operation: [], provider: [], model: [], topConsumers: [], recent: [],
});

afterEach(() => {
  mock.restore();
  delete process.env.PIXIE_CORE_BASE_URL;
  delete process.env.PIXIE_INTERNAL_TOKEN;
});

test("coreUsage sends a program-scoped, encoded date range", async () => {
  process.env.PIXIE_CORE_BASE_URL = "https://core.example";
  process.env.PIXIE_INTERNAL_TOKEN = "secret";
  const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(response("program/a")), { status: 200 })));
  globalThis.fetch = fetchMock as typeof fetch;
  await coreUsage("program/a", { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" });
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/programs/program%2Fa/usage?from="), expect.anything());
});

test("coreUsage rejects invalid ranges and a response for another program", async () => {
  await expect(coreUsage("program/a", { from: "not-a-date", to: "2026-01-02" })).rejects.toThrow("usage range is invalid");
  process.env.PIXIE_CORE_BASE_URL = "https://core.example";
  process.env.PIXIE_INTERNAL_TOKEN = "secret";
  globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(response("other")), { status: 200 }))) as typeof fetch;
  await expect(coreUsage("program/a", { from: "2026-01-01", to: "2026-01-02" })).rejects.toThrow("invalid response");
});
