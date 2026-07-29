process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");

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
  db.putCachedAnswer("hash-a", "how do i join", { source: "Pixl FAQ", answer: "just sign up" });
  assert.deepEqual(db.getCachedAnswer("hash-a"), { source: "Pixl FAQ", answer: "just sign up" });
  assert.equal(db.getCachedAnswer("hash-missing"), null);
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

test("medianLatency returns null with no data and a value once recorded", () => {
  assert.equal(db.medianLatency("nothing_recorded"), null);
  db.recordMetric("answer_docs", 100);
  db.recordMetric("answer_docs", 200);
  db.recordMetric("answer_docs", 300);
  assert.equal(db.medianLatency("answer_docs"), 200);
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
