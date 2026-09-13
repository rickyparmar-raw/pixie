// supportContext pins: bounded, program-pure conversation context.
// - thread transcript only for doc lookups (cache stays working);
// - per-user topics ONLY for explicit recall questions;
// - newest message preserved exactly, never summarized;
// - bare referential messages inherit the last real user question;
// - subject-carrying follow-ups ("what about software?") keep their text.
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const context = require("./context");
const supportContext = require("./supportContext");
const respond = require("./respond");

db.open(":memory:");

before(() => {
  db.handle().query("DELETE FROM thread_messages").run();
});

test("buildContextPrompt is empty without history so the cache keeps working", () => {
  assert.equal(supportContext.buildContextPrompt(null), "");
  assert.equal(supportContext.buildContextPrompt(""), "");
  assert.match(supportContext.buildContextPrompt("user: hi"), /Previous conversation/);
});

test("per-user topics inject only for recall questions", () => {
  const user = { recentTopics: ["tiers"] };
  assert.doesNotMatch(supportContext.buildChatContext("user: hi", user, "what are tiers?"), /tiers/);
  assert.match(
    supportContext.buildChatContext(null, user, "what did I ask before?"),
    /tiers/,
  );
  assert.match(
    supportContext.buildChatContext(null, null, "what did I ask before?"),
    /no record/,
  );
});

test("bare referential messages inherit the last real question", () => {
  const ts = "ctx-ref-1";
  // Seeded ONLY through context.addToThread — the production write path.
  // (Seeding db.addThreadMessage directly here once masked the split-store
  // regression where the referential lookup read an empty map.)
  context.addToThread(ts, "user", "how do i submit?", "U1", "C1");
  context.addToThread(ts, "assistant", "push to github.", null, "C1");
  assert.equal(supportContext.resolveEffectiveQuestion("this", ts), "how do i submit?");
  assert.equal(supportContext.resolveEffectiveQuestion("^", ts), "how do i submit?");
});

test("thread stores are reunited: every writer is visible to every reader", () => {
  const ts = "ctx-reunite-1";
  context.addToThread(ts, "user", "my build fails on step two", "U9", "C9");
  db.addThreadMessage(ts, "assistant", "which step errors?", null);
  const viaDb = db.getThreadMessages(ts);
  assert.equal(viaDb.length, 2);
  assert.equal(viaDb[0].content, "my build fails on step two");
  assert.equal(viaDb[0].user_id, "U9");
  assert.equal(viaDb[1].role, "assistant");
  // The copilot/resolution-memory read path sees the same rows.
  const viaContext = context.getThreadMessages(ts);
  assert.equal(viaContext.length, 2);
  assert.equal(viaContext[0].text, "my build fails on step two");
});

test("subject-carrying follow-ups keep their own text", () => {
  assert.equal(supportContext.resolveEffectiveQuestion("what about software?", "ctx-ref-1"), "what about software?");
  assert.equal(supportContext.resolveEffectiveQuestion("how do i start?", null), "how do i start?");
});

test("respond.js still exposes the historical context surface", () => {
  assert.equal(respond.buildContextPrompt("user: hi"), supportContext.buildContextPrompt("user: hi"));
  assert.equal(respond.isRecallQuestion("what did I ask before?"), true);
  assert.equal(respond.isRecallQuestion("what are tiers?"), false);
});

test("referential messages with no history keep their own text", () => {
  assert.equal(supportContext.resolveEffectiveQuestion("this", "ctx-empty-1"), "this");
  assert.equal(supportContext.resolveEffectiveQuestion("^", null), "^");
});
