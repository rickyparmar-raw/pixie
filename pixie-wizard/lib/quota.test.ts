import { expect, test } from "bun:test";
import { calculateUsedCents } from "./quota";

const usage = (overrides: Record<string, unknown> = {}) => ({
  programId: "program-a", from: "2026-01-01", to: "2026-02-01", precision: "exact",
  requests: 1, inputTokens: 1, outputTokens: 1, cachedInputTokens: 1, costCents: null,
  summary: { requests: 1, inputTokens: 1, outputTokens: 1, cachedInputTokens: 1, costCents: null },
  timeseries: [], operation: [], provider: [], model: [], topConsumers: [], recent: [], ...overrides,
} as any);

test("uses Core's authoritative cost without exposing raw usage rows", () => {
  expect(calculateUsedCents(usage({ summary: { requests: 1, inputTokens: 1, outputTokens: 1, cachedInputTokens: 1, costCents: 42 } }))).toEqual({ cents: 42, precision: "exact" });
});

test("estimates cost from the centralized catalog when Core has no receipt", () => {
  expect(calculateUsedCents(usage({ precision: "estimated", model: [{ provider: "openai", name: "gpt-4o-mini", requests: 1, inputTokens: 1_000_000, outputTokens: 2_000_000, cachedInputTokens: 500_000, costCents: null }] }))).toEqual({ cents: 128.5, precision: "estimated" });
});


test("preserves unavailable semantics instead of inventing a zero", () => {
  expect(calculateUsedCents(usage({ precision: "unavailable" }))).toEqual({ cents: null, precision: "unavailable" });
});

test("unknown model pricing is unavailable, not a guessed estimate", () => {
  expect(calculateUsedCents(usage({ precision: "estimated", model: [{ provider: "unknown", name: "model", requests: 1, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costCents: null }] }))).toEqual({ cents: null, precision: "unavailable" });
});
