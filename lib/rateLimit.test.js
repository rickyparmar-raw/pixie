// STEP 1 characterization pins for lib/rateLimit.js (PLATFORM FOUNDATION).
// Per-user throttle: generous for humans, closed for scripts.
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const rateLimit = require("./rateLimit");

db.open(":memory:");

test("char: missing user is always allowed", () => {
  assert.deepEqual(rateLimit.check(null), { allowed: true, retryInMs: 0 });
  assert.deepEqual(rateLimit.check(undefined), { allowed: true, retryInMs: 0 });
  assert.deepEqual(rateLimit.check(""), { allowed: true, retryInMs: 0 });
});

test("char: first N requests allowed, N+1 denied within the window", () => {
  const user = `char-rl-${Date.now()}-1`;
  const max = 3;
  for (let i = 0; i < max; i++) {
    assert.equal(rateLimit.check(user, { windowMs: 60000, max }).allowed, true);
  }
  const denied = rateLimit.check(user, { windowMs: 60000, max });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryInMs, 60000);
});

test("char: limits are per-user, never global", () => {
  const a = `char-rl-${Date.now()}-a`;
  const b = `char-rl-${Date.now()}-b`;
  const max = 1;
  assert.equal(rateLimit.check(a, { windowMs: 60000, max }).allowed, true);
  assert.equal(rateLimit.check(a, { windowMs: 60000, max }).allowed, false);
  assert.equal(rateLimit.check(b, { windowMs: 60000, max }).allowed, true);
});

test("char: window expiry re-allows", () => {
  const user = `char-rl-${Date.now()}-w`;
  assert.equal(rateLimit.check(user, { windowMs: 1, max: 1 }).allowed, true);
  db.handle().query("UPDATE rate_limits SET created_at = ? WHERE user_id = ?").run(Date.now() - 10000, user);
  assert.equal(rateLimit.check(user, { windowMs: 1, max: 1 }).allowed, true);
});

test("char: denied checks do not consume further budget rows", () => {
  const user = `char-rl-${Date.now()}-d`;
  const max = 1;
  rateLimit.check(user, { windowMs: 60000, max });
  const before = db.countRecentRequests(user, 60000);
  rateLimit.check(user, { windowMs: 60000, max });
  assert.equal(db.countRecentRequests(user, 60000), before);
});

test("char: default window and max are sane", () => {
  assert.ok(rateLimit.WINDOW_MS >= 1000);
  assert.ok(rateLimit.MAX_PER_WINDOW >= 1 && rateLimit.MAX_PER_WINDOW <= 100);
});
