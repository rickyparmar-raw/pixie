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

test("thread context stays bounded after a 100-message thread", () => {
  for (let index = 0; index < 100; index += 1) {
    context.addToThread("ctx-100", index % 2 ? "assistant" : "user", `message ${index}`);
  }

  const rendered = context.getThreadContext("ctx-100");
  assert.ok(rendered.length <= 4000);
  assert.ok(rendered.split("\n").length <= 8);
  assert.match(rendered, /message 99/);
  assert.doesNotMatch(rendered, /message 0/);
});

test("latest question is always retained during compaction", () => {
  for (let index = 0; index < 20; index += 1) {
    context.addToThread("ctx-latest", "user", `unrelated archive ${index}`);
  }
  context.addToThread("ctx-latest", "user", "how do I configure the webhook timeout?");

  const rendered = context.getThreadContext("ctx-latest");
  assert.match(rendered, /configure the webhook timeout/);
});

test("follow-up context preserves the entity from the preceding exchange", () => {
  context.addToThread("ctx-follow-up", "user", "How do I configure the webhook timeout?");
  context.addToThread("ctx-follow-up", "assistant", "Set the webhook timeout in the delivery settings.");
  context.addToThread("ctx-follow-up", "user", "What about retries?");

  const rendered = context.getThreadContext("ctx-follow-up");
  assert.match(rendered, /webhook timeout/);
  assert.match(rendered, /What about retries/);
});

test("relevant older turns outrank unrelated recent chatter", () => {
  context.addToThread("ctx-relevance", "user", "How do I rotate the API key for production?");
  context.addToThread("ctx-relevance", "assistant", "Rotate it from the production credentials page.");
  for (let index = 0; index < 10; index += 1) {
    context.addToThread("ctx-relevance", "user", `unrelated chatter about lunch ${index}`);
  }
  context.addToThread("ctx-relevance", "user", "Where is the API key setting?");

  const rendered = context.getThreadContext("ctx-relevance");
  assert.match(rendered, /production credentials/);
  assert.doesNotMatch(rendered, /unrelated chatter about lunch 0/);
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

test("isReplyToPixie: everything since Pixie's last message is from this sender", () => {
  const BOT = "UBOT";
  const pixie = { user: BOT, ts: "1" };
  const me = (ts) => ({ user: "UME", ts });
  const other = (ts) => ({ user: "UOTHER", ts });
  assert.equal(context.isReplyToPixie([other("0"), pixie], "UME", BOT), true, "direct reply");
  assert.equal(context.isReplyToPixie([pixie, me("2")], "UME", BOT), true, "follow-up in two parts");
  assert.equal(context.isReplyToPixie([pixie, other("2")], "UME", BOT), false, "someone spoke in between");
  assert.equal(context.isReplyToPixie([me("0"), other("1")], "UME", BOT), false, "Pixie never spoke");
  assert.equal(context.isReplyToPixie([{ bot_id: "B1", ts: "1" }], "UME", BOT), true, "bot_id counts as Pixie");
});

test("seedFromSlack re-seeds a thread whose in-memory transcript was lost", async () => {
  db.touchThread("seed-restart", "C1", { seeded: true });
  let calls = 0;
  const client = { conversations: { replies: async () => { calls += 1; return { messages: [{ user: "U1", text: "what is pixl", ts: "1" }] }; } } };
  await context.seedFromSlack(client, "C1", "seed-restart", "UBOT");
  assert.equal(calls, 1);
  assert.match(context.getThreadContext("seed-restart") || "", /what is pixl/);
  await context.seedFromSlack(client, "C1", "seed-restart", "UBOT");
  assert.equal(calls, 1, "a thread with a live transcript is not fetched twice");
});
