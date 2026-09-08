import { test, expect } from "bun:test";
import { coreEndpointLabel, coreFetchErrorMessage } from "./pixieCoreErrors";

test("coreEndpointLabel drops the query string, keeps the operation path", () => {
  expect(coreEndpointLabel("/internal/v1/programs/acme/analytics?days=30")).toBe(
    "/internal/v1/programs/acme/analytics",
  );
  expect(coreEndpointLabel("/internal/v1/slack/channels")).toBe("/internal/v1/slack/channels");
});

test("a timeout is reported as a timeout, with the endpoint and no query string", () => {
  const msg = coreFetchErrorMessage(
    new DOMException("The operation timed out.", "TimeoutError"),
    "/internal/v1/programs/acme/analytics?days=30",
    10_000,
  );
  expect(msg).toMatch(/timed out after 10000ms/);
  expect(msg).toContain("/internal/v1/programs/acme/analytics");
  expect(msg).not.toContain("days=30");
});

test("a non-timeout rejection is reported as unreachable, distinct from a timeout", () => {
  const msg = coreFetchErrorMessage(new TypeError("fetch failed"), "/internal/v1/programs/acme/radar", 10_000);
  expect(msg).toMatch(/unreachable/i);
  expect(msg).not.toMatch(/timed out/i);
});

test("the message never carries a token, an Authorization header, or a raw payload", () => {
  const timeout = coreFetchErrorMessage(
    new DOMException("x", "TimeoutError"),
    "/internal/v1/tickets/42?programId=acme&token=leak",
    10_000,
  );
  const down = coreFetchErrorMessage(new Error("boom"), "/internal/v1/tickets/42?programId=acme", 10_000);
  for (const msg of [timeout, down]) {
    expect(msg).not.toMatch(/Bearer/i);
    expect(msg).not.toContain("token=leak");
    expect(msg).not.toContain("programId=acme");
  }
});
