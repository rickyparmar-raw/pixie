type TestAny = any;
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("./config");
const log = require("./log");

test("subscribers see every level with scope and args", () => {
  const seen: unknown[][] = [];
  const unsub = log.subscribe((kind: string, scope: string, args: unknown[]) => seen.push([kind, scope, args]));
  try {
    log.info("char", "hello", 42);
    log.warn("char", "careful");
    log.error("char", "broken");
    assert.ok(seen.some(([k, s]: TestAny) => k === "info" && s === "char"));
    assert.ok(seen.some(([k]: TestAny) => k === "warn"));
    assert.ok(seen.some(([k]: TestAny) => k === "error"));
  } finally {
    unsub();
  }
});

test("unsubscribe stops delivery", () => {
  let calls = 0;
  const unsub = log.subscribe(() => {
    calls += 1;
  });
  unsub();
  log.info("char", "after unsub");
  assert.equal(calls, 0);
});

test("a throwing subscriber never breaks logging", () => {
  const unsub = log.subscribe(() => {
    throw new Error("subscriber on fire");
  });
  try {
    assert.doesNotThrow(() => log.info("char", "still logs"));
    assert.doesNotThrow(() => log.warn("char", "still warns"));
  } finally {
    unsub();
  }
});

test("debug notifies even when console output is gated", () => {
  const saved = config.debug;
  config.debug = false;
  const seen: string[] = [];
  const unsub = log.subscribe((kind: TestAny) => seen.push(kind));
  try {
    log.debug("char", "quiet");
    assert.ok(seen.includes("debug"));
  } finally {
    config.debug = saved;
    unsub();
  }
});

test("subscribe returns an idempotent unsubscriber", () => {
  const unsub = log.subscribe(() => {});
  assert.doesNotThrow(() => {
    unsub();
    unsub();
  });
});
export {};
