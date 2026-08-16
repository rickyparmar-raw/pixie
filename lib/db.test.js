process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const cache = require("./cache");

db.open(":memory:");

test("claimMessage is atomic — only the first caller wins", () => {
  assert.equal(db.claimMessage("111.1", "C1"), true);
  assert.equal(db.claimMessage("111.1", "C1"), false);
  assert.equal(db.wasAnswered("111.1"), true);
  assert.equal(db.wasAnswered("999.9"), false);
});

test("thread messages come back in order and are capped", () => {
  for (let i = 0; i < db.MAX_THREAD_MESSAGES + 5; i++) {
    db.addThreadMessage("t1", "user", `msg ${i}`, "U1");
  }
  const messages = db.getThreadMessages("t1");
  assert.equal(messages.length, db.MAX_THREAD_MESSAGES);
  // Oldest trimmed, newest kept.
  assert.equal(messages.at(-1).content, `msg ${db.MAX_THREAD_MESSAGES + 4}`);
});

test("touchThread records that pixie spoke without clobbering on later writes", () => {
  db.touchThread("t2", "C1", { pixieSpoke: true });
  db.touchThread("t2", "C1", {});
  assert.equal(db.getThread("t2").pixie_spoke, 1);
});

test("user topics are capped at the most recent N", () => {
  for (let i = 0; i < db.MAX_USER_TOPICS + 4; i++) {
    db.recordTopic("U2", `topic-${i}`, true);
  }
  assert.equal(db.getTopics("U2").length, db.MAX_USER_TOPICS);
});

test("answer cache round-trips and misses on an unknown key", () => {
  cache.putCachedAnswer("hash-a", "how do i join", { source: "Pixl FAQ", answer: "just sign up" });

  const hit = cache.getCachedAnswer("hash-a");
  assert.equal(hit.source, "Pixl FAQ");
  assert.equal(hit.answer, "just sign up");
  assert.ok(hit.ageMs >= 0);
  assert.equal(cache.getCachedAnswer("hash-missing"), null);
});

// The ask count is the only record of which questions are worth remembering —
// retention and the background refresh order both key off it.
test("every hit bumps the ask count", () => {
  cache.putCachedAnswer("hash-count", "whats the deadline", { source: "Pixl FAQ", answer: "august 18" });
  assert.equal(cache.getCachedAnswer("hash-count").askCount, 1);
  assert.equal(cache.getCachedAnswer("hash-count").askCount, 2);
  assert.equal(cache.getCachedAnswer("hash-count").askCount, 3);
});

// A background refresh is pixie updating itself, not somebody asking. Counting
// it would let the warmer promote its own entries up the refresh order.
test("a refresh updates the answer without counting as an ask", () => {
  // topCached reads without bumping — getCachedAnswer counts as an ask, so it
  // can't be used to observe the count it changes.
  const countOf = (question) => cache.topCached(50).find((r) => r.question === question)?.ask_count;

  cache.putCachedAnswer("hash-refresh", "how do i submit", { source: "Pixl Docs", answer: "old answer" });
  cache.getCachedAnswer("hash-refresh");
  cache.getCachedAnswer("hash-refresh");
  const before = countOf("how do i submit");

  cache.putCachedAnswer("hash-refresh", "how do i submit", { source: "Pixl Docs", answer: "new answer" }, { refreshed: true });

  assert.equal(countOf("how do i submit"), before, "a refresh is pixie updating itself, not somebody asking");
  assert.equal(cache.getCachedAnswer("hash-refresh").answer, "new answer");
});

// The whole point of the change: an answer people keep asking for must survive
// a sweep that used to delete everything older than six hours.
test("sweep keeps a question people still ask and drops one nobody does", () => {
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000;

  cache.putCachedAnswer("hash-popular", "how do i join", { source: "Pixl FAQ", answer: "sign up" });
  cache.putCachedAnswer("hash-forgotten", "some one-off thing", { source: "Pixl Docs", answer: "whatever" });

  // Both written long ago; only one has been asked for since.
  db.handle().query("UPDATE answer_cache SET created_at = ?, last_asked_at = ? WHERE question_hash = ?").run(old, old, "hash-forgotten");
  db.handle().query("UPDATE answer_cache SET created_at = ?, last_asked_at = ? WHERE question_hash = ?").run(old, Date.now(), "hash-popular");

  db.sweep();

  assert.notEqual(cache.getCachedAnswer("hash-popular"), null, "a question still being asked must survive");
  assert.equal(cache.getCachedAnswer("hash-forgotten"), null, "a phrasing nobody has asked in a week goes");
});

// The warmer spends a limited budget, so it has to spend it on the questions
// the most people are waiting on.
test("staleCacheEntries returns the stalest most-asked first", () => {
  cache.clearCache();
  const old = Date.now() - 60 * 60 * 1000;

  cache.putCachedAnswer("s-rare", "rare question", { source: "Pixl Docs", answer: "a" });
  cache.putCachedAnswer("s-common", "common question", { source: "Pixl Docs", answer: "b" });
  cache.putCachedAnswer("s-fresh", "fresh question", { source: "Pixl Docs", answer: "c" });

  db.handle().query("UPDATE answer_cache SET refreshed_at = ? WHERE question_hash IN ('s-rare','s-common')").run(old);
  db.handle().query("UPDATE answer_cache SET ask_count = 30 WHERE question_hash = 's-common'").run();

  const stale = cache.staleCacheEntries(30 * 60 * 1000, 10);
  assert.deepEqual(
    stale.map((r) => r.question),
    ["common question", "rare question"],
    "fresh entries are left alone, and the most-asked stale one comes first",
  );
});

test("topGaps groups identical questions and counts them", () => {
  db.recordGap("Whats the deadline", "U1", "C1");
  db.recordGap("whats the deadline  ", "U2", "C1");
  db.recordGap("something else entirely", "U3", "C1");

  const gaps = db.topGaps(10);
  const deadline = gaps.find((g) => g.question === "whats the deadline");
  assert.equal(deadline.count, 2);
  assert.equal(gaps.find((g) => g.question === "something else entirely").count, 1);
});

test("feedback is one vote per user and can be changed or removed", () => {
  db.recordFeedback("m1", "U1", 1);
  db.recordFeedback("m1", "U1", -1); // same user changes their mind
  db.recordFeedback("m1", "U2", 1);

  let totals = db.feedbackTotals();
  assert.equal(totals.up, 1);
  assert.equal(totals.down, 1);

  db.removeFeedback("m1", "U1");
  totals = db.feedbackTotals();
  assert.equal(totals.down, 0);
});

test("guide state persists and clears", () => {
  db.saveGuide("t3", "git-setup", 0, "U1");
  assert.equal(db.getGuide("t3").guide_id, "git-setup");

  db.saveGuide("t3", "git-setup", 2, "U1");
  assert.equal(db.getGuide("t3").current_step, 2);

  db.deleteGuide("t3");
  assert.equal(db.getGuide("t3"), null);
});

test("guide message_ts links a posted step back to its guide", () => {
  db.saveGuide("t3-msg", "git-setup", 0, "U1");
  assert.equal(db.getGuideByMessageTs("1234.5678"), null);

  db.setGuideMessageTs("t3-msg", "1234.5678");
  const row = db.getGuideByMessageTs("1234.5678");
  assert.equal(row.thread_ts, "t3-msg");
  assert.equal(row.guide_id, "git-setup");

  // A later step's message replaces the pointer — the old ts no longer
  // resolves to anything, so a stale reaction can't match the wrong step.
  db.setGuideMessageTs("t3-msg", "9999.0001");
  assert.equal(db.getGuideByMessageTs("1234.5678"), null);
  assert.equal(db.getGuideByMessageTs("9999.0001").thread_ts, "t3-msg");

  db.deleteGuide("t3-msg");
  assert.equal(db.getGuideByMessageTs("9999.0001"), null);
});

// Deliberately a kind nothing else records. Bun runs every test file in one
// process against one in-memory database, so asserting on a real metric name
// makes this pass or fail depending on which other file ran first.
test("medianLatency returns null with no data and a value once recorded", () => {
  assert.equal(db.medianLatency("nothing_recorded"), null);
  db.recordMetric("median_fixture", 100);
  db.recordMetric("median_fixture", 200);
  db.recordMetric("median_fixture", 300);
  assert.equal(db.medianLatency("median_fixture"), 200);
});

test("rate limit counts only requests inside the window", () => {
  db.recordRequest("U9");
  db.recordRequest("U9");
  assert.equal(db.countRecentRequests("U9", 60000), 2);
  // A zero-width window can't contain anything just written.
  assert.equal(db.countRecentRequests("U9", -1), 0);
});

test("sweep runs without error", () => {
  assert.doesNotThrow(() => db.sweep());
});
