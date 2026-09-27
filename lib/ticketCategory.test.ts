// @ts-nocheck
export {};

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

/* ------------------------------------------------- PIXL live taxonomy --- */
// The old three-bucket taxonomy (review / ops / support) collapsed almost
// every miscellaneous question into "support", whose fallback name matched
// Ricky's own self-declared/observed expertise tag — an accidental sink.
// This locks the real, wider PIXL taxonomy from programs.json in place so a
// future edit can't silently narrow it back down.

function pixlRules() {
  // Loaded fresh each test via require cache — programs.js reads the file
  // once and caches it, so this indirectly also proves the checked-in
  // programs.json actually has the categories this test expects.
  const programs = require("./programs");
  return programs.get("pixl").categories;
}

test("PIXL fallback is general_support, not the old Ricky-shaped 'support'", () => {
  assert.equal(pixlRules().fallback, "general_support");
  assert.equal(configuredCategories(pixlRules()).includes("support"), false);
});

test("PIXL taxonomy covers at least the nine required concepts", () => {
  const cats = configuredCategories(pixlRules());
  for (const required of [
    "review", "journals_hours", "project_requirements", "ai_policy",
    "hardware", "shop_orders", "account_platform", "program_ops", "general_support",
  ]) {
    assert.ok(cats.includes(required), `missing category: ${required}`);
  }
});

test("PIXL routes representative live-support questions to distinct, non-support categories", () => {
  const rules = pixlRules();
  const cases = [
    ["why is my second pass taking so long?", "review"],
    ["does learning Java count toward my project hours?", "journals_hours"],
    ["can I journal hand-drawn art?", "journals_hours"],
    ["can I use this much AI?", "ai_policy"],
    ["how do I wire up my PCB to the ESP32?", "hardware"],
    ["my hardware grant hasn't shipped yet", "shop_orders"],
    ["website isn't loading for me", "account_platform"],
    ["when is the deadline for pixl", "program_ops"],
    ["can I resubmit my rejected project", "review"],
  ];
  const seen = new Set();
  for (const [question, expected] of cases) {
    const got = classify({ question, rules });
    assert.equal(got, expected, question);
    seen.add(got);
  }
  // The whole point: these representative questions must not all funnel into
  // one bucket.
  assert.ok(seen.size >= 6, `expected a spread of categories, got only ${[...seen].join(", ")}`);
});
