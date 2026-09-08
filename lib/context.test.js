process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const context = require("./context");

db.open(":memory:");

// Raw question text used to be stored as the "topic" and pasted verbatim into
// every prompt — ten full sentences of prompt bloat per user.
test("deriveTopic reduces a question to keywords", () => {
  assert.equal(context.deriveTopic("how do i unlock the next region?"), "unlock next region");
  assert.equal(context.deriveTopic("Where can I find the docs"), "find docs");
});

test("deriveTopic drops code blocks and mentions", () => {
  assert.equal(context.deriveTopic("<@U1> why does ```const x = 1``` break hackatime"), "break hackatime");
});

test("deriveTopic falls back to a truncated question when everything is a stopword", () => {
  assert.equal(context.deriveTopic("how do i do it"), "how do i do it");
});

test("deriveTopic handles empty input", () => {
  assert.equal(context.deriveTopic(""), "");
  assert.equal(context.deriveTopic(undefined), "");
});

test("thread context renders as a role-prefixed transcript", () => {
  context.addToThread("ctx-1", "user", "how do i join", "U1", "C1");
  context.addToThread("ctx-1", "assistant", "just sign up", null, "C1");

  assert.equal(context.getThreadContext("ctx-1"), "user: how do i join\nassistant: just sign up");
});

test("getThreadContext returns null for an unknown thread", () => {
  assert.equal(context.getThreadContext("ctx-unknown"), null);
});

test("hasSpokenInThread flips only once pixie replies", () => {
  context.addToThread("ctx-2", "user", "anyone here", "U1", "C1");
  assert.equal(context.hasSpokenInThread("ctx-2"), false);

  context.addToThread("ctx-2", "assistant", "yep", null, "C1");
  assert.equal(context.hasSpokenInThread("ctx-2"), true);
});

test("user context exposes derived topics, not raw questions", () => {
  context.updateUserHistory("U7", "how do i unlock the next region?", true);
  const userContext = context.getUserContext("U7");

  assert.deepEqual(userContext.recentTopics, ["unlock next region"]);
  assert.deepEqual(userContext.helpfulAnswers, ["unlock next region"]);
});

test("unhelpful answers are tracked as topics but not as helpful ones", () => {
  context.updateUserHistory("U8", "what is the airspeed of a swallow", false);
  const userContext = context.getUserContext("U8");

  assert.equal(userContext.recentTopics.length, 1);
  assert.deepEqual(userContext.helpfulAnswers, []);
});

test("getUserContext returns null for an unseen user", () => {
  assert.equal(context.getUserContext("U-nobody"), null);
});

/* ------------------------------------------------ STEP 1 char pins -- */
// Thread key scoping: threads are isolated by ts; seeding skips the live
// message and never throws.

test("char: threads are isolated by ts", () => {
  context.addToThread("char-t-a", "user", "alpha question", "U1", "C1");
  context.addToThread("char-t-b", "user", "beta question", "U1", "C1");
  assert.match(context.getThreadContext("char-t-a"), /alpha question/);
  assert.doesNotMatch(context.getThreadContext("char-t-a"), /beta question/);
});

test("char: addToThread with no ts is a no-op, never throws", () => {
  assert.doesNotThrow(() => context.addToThread(null, "user", "lost message", "U1", "C1"));
  assert.doesNotThrow(() => context.addToThread(undefined, "user", "lost message", "U1", "C1"));
});

test("char: seedFromSlack skips the live message and empty texts", async () => {
  const client = {
    conversations: {
      replies: async () => ({
        messages: [
          { ts: "10.1", text: "first question", user: "U1" },
          { ts: "10.2", text: "   ", user: "U2" },
          { ts: "10.3", text: "live question", user: "U1" },
        ],
      }),
    },
  };
  await context.seedFromSlack(client, "C1", "char-seed-1", "UBOT", "10.3");
  const ctx = context.getThreadContext("char-seed-1");
  assert.match(ctx, /first question/);
  assert.doesNotMatch(ctx, /live question/);
  // Second call is a no-op (seeded flag): no duplicate rows.
  await context.seedFromSlack(client, "C1", "char-seed-1", "UBOT", "10.3");
  assert.equal(context.getThreadContext("char-seed-1"), ctx);
});

test("char: seedFromSlack failure is non-fatal and still marks seeded", async () => {
  const failing = { conversations: { replies: async () => { throw new Error("channel_not_found"); } } };
  await assert.doesNotReject(() => context.seedFromSlack(failing, "C1", "char-seed-fail", "UBOT"));
  assert.equal(context.getThreadContext("char-seed-fail"), null);
});

test("char: bot messages seed as assistant role", async () => {
  const client = {
    conversations: {
      replies: async () => ({ messages: [{ ts: "20.1", text: "bot reply", user: "UBOT" }] }),
    },
  };
  await context.seedFromSlack(client, "C1", "char-seed-bot", "UBOT");
  assert.match(context.getThreadContext("char-seed-bot"), /assistant: bot reply/);
});
