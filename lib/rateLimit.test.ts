// STEP 1 characterization pins for lib/rateLimit.js (PLATFORM FOUNDATION).
// Per-user throttle: generous for humans, closed for scripts.
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const rateLimit = require("./rateLimit");

db.open(":memory:");

test("char: missing user is always allowed", () => {
  assert.deepEqual(rateLimit.check(null), { allowed: true, retryInMs: 0, reason: "no_identity" });
  assert.deepEqual(rateLimit.check(undefined), { allowed: true, retryInMs: 0, reason: "no_identity" });
  assert.deepEqual(rateLimit.check(""), { allowed: true, retryInMs: 0, reason: "no_identity" });
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

test("reservations are atomic at the limit", () => {
  const user = `char-rl-${Date.now()}-atomic`;
  const max = 4;
  const results = Array.from({ length: 20 }, () => rateLimit.check(user, { windowMs: 60000, max }));
  assert.equal(results.filter((result: any) => result.allowed).length, max);
  assert.equal(db.countRecentRequests(user, 60000), max);
});

test("DM mode fails closed without a stable identity", () => {
  assert.deepEqual(rateLimit.check(null, { dm: true }), {
    allowed: false,
    retryInMs: 0,
    reason: "missing_identity",
  });
});

test("a new thread does not reset a scoped user's window", () => {
  const user = `char-rl-${Date.now()}-thread`;
  const scope = "D123";
  assert.equal(rateLimit.check({ userId: user, channelId: scope, threadTs: "old" }, { max: 1 }).allowed, true);
  assert.equal(rateLimit.check({ userId: user, channelId: scope, threadTs: "new" }, { max: 1 }).allowed, false);
});

test("scoped reservations count legacy bare-user rows", () => {
  const user = `char-rl-${Date.now()}-legacy`;
  const scope = "D-legacy";
  db.handle().query("INSERT INTO rate_limits (user_id, created_at) VALUES (?, ?)").run(user, Date.now());

  const result = rateLimit.check({ userId: user, channelId: scope }, { max: 1 });

  assert.deepEqual(result, { allowed: false, retryInMs: 60000, reason: "limit" });
  assert.equal(db.handle().query("SELECT COUNT(*) AS count FROM rate_limits WHERE user_id = ?").get(`${scope}:${user}`).count, 0);
});

test("scoped reservations retain their own accounting after legacy compatibility", () => {
  const user = `char-rl-${Date.now()}-scoped-count`;
  const scope = "D-scoped-count";
  assert.equal(rateLimit.check({ userId: user, channelId: scope }, { max: 2 }).allowed, true);
  assert.equal(rateLimit.check({ userId: user, channelId: scope }, { max: 2 }).allowed, true);
  assert.equal(rateLimit.check({ userId: user, channelId: scope }, { max: 2 }).allowed, false);

  assert.equal(db.countRecentRequests(`${scope}:${user}`, 60000), 2);
  assert.equal(db.countRecentRequests(user, 60000), 0);
});

test("char: default window and max are sane", () => {
  assert.ok(rateLimit.WINDOW_MS >= 1000);
  assert.ok(rateLimit.MAX_PER_WINDOW >= 1 && rateLimit.MAX_PER_WINDOW <= 100);
});
export {};
