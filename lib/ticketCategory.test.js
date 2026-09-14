const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classify, configuredCategories } = require("./ticketCategory");

const RULES = {
  byChannel: { "C-REVIEW": "review" },
  byKeyword: [
    { category: "review", match: ["review", "resubmit", "rejected"] },
    { category: "ops", match: ["payout", "shipping", "address"] },
  ],
  fallback: "support",
};

test("an unconfigured program classifies nothing", () => {
  assert.equal(classify({ question: "my payout is late", channel: "C-REVIEW" }), null);
  assert.equal(classify({ question: "anything", rules: null }), null);
  assert.equal(classify({}), null);
});

test("channel beats keyword, because where it was asked is a fact and wording is a guess", () => {
  assert.equal(classify({ question: "when does my payout arrive?", channel: "C-REVIEW", rules: RULES }), "review");
  assert.equal(classify({ question: "when does my payout arrive?", channel: "C-HELP", rules: RULES }), "ops");
});

test("keyword rules match whole words, in rule order", () => {
  assert.equal(classify({ question: "can I resubmit this?", rules: RULES }), "review");
  assert.equal(classify({ question: "what is my shipping address", rules: RULES }), "ops");
  // "approved" is not a configured term, and "unreviewed" must not match "review".
  assert.equal(classify({ question: "is this unreviewed still?", rules: RULES }), "support");
});

test("the fallback catches anything the rules do not, and stays null when unset", () => {
  assert.equal(classify({ question: "hello there", rules: RULES }), "support");
  assert.equal(classify({ question: "hello there", rules: { byKeyword: RULES.byKeyword } }), null);
});

test("categories normalize to the same shape helper expertise tags use", () => {
  const shouty = { byChannel: { "C-X": "  REVIEW  " }, fallback: "Support" };
  assert.equal(classify({ channel: "C-X", rules: shouty }), "review");
  assert.equal(classify({ channel: "C-OTHER", rules: shouty }), "support");
});

test("configuredCategories reports every category a program's rules can produce", () => {
  assert.deepEqual(configuredCategories(RULES), ["ops", "review", "support"]);
  assert.deepEqual(configuredCategories(null), []);
  assert.deepEqual(configuredCategories({}), []);
});

test("a question with a regex-special term does not throw or over-match", () => {
  const rules = { byKeyword: [{ category: "ops", match: ["c++", "a.b"] }] };
  assert.equal(classify({ question: "help with c++ builds", rules }), "ops");
  assert.equal(classify({ question: "help with axb builds", rules }), null);
});
