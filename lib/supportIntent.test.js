// Support-intent boundary pins: the classifier decides support-need ONLY;
// grounding decides the answer. Forced verdicts and registered overrides
// short-circuit without a model call but still normalize identically.
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const intent = require("./intent");
const supportIntent = require("./supportIntent");

before(() => supportIntent.clearIntentOverrides());
after(() => supportIntent.clearIntentOverrides());

test("delegates to the classifier and normalizes identically", async () => {
  const real = intent.classifyIntentContext;
  const verdict = { verdict: intent.HELP_NEEDED, addressedToPixie: false, directedAtHuman: false, recentPixieParticipation: false, programRelevance: "relevant" };
  intent.classifyIntentContext = async () => verdict;
  try {
    const viaBoundary = await supportIntent.classifySupportIntent("how do i submit?", { id: "p" }, {});
    const direct = intent.normalizeIntentResult(verdict, {});
    assert.deepEqual(viaBoundary, direct);
    assert.equal(viaBoundary.shouldAttemptAnswer, true);
  } finally {
    intent.classifyIntentContext = real;
  }
});

test("classifier failure stays fail-closed null", async () => {
  const real = intent.classifyIntentContext;
  intent.classifyIntentContext = async () => {
    throw new Error("model down");
  };
  try {
    assert.equal(await supportIntent.classifySupportIntent("hello?", null, {}), null);
  } finally {
    intent.classifyIntentContext = real;
  }
});

test("forceVerdict short-circuits without calling the classifier", async () => {
  const real = intent.classifyIntentContext;
  let called = 0;
  intent.classifyIntentContext = async () => {
    called += 1;
    return null;
  };
  try {
    const verdict = { verdict: intent.CASUAL_CHAT, addressedToPixie: false, directedAtHuman: false, recentPixieParticipation: false, programRelevance: "relevant" };
    const result = await supportIntent.classifySupportIntent("tiers are cool lol", null, { forceVerdict: verdict });
    assert.equal(called, 0);
    assert.equal(result.shouldAttemptAnswer, false);
  } finally {
    intent.classifyIntentContext = real;
  }
});

test("registered overrides plug in without touching respond()", async () => {
  const real = intent.classifyIntentContext;
  let classifierCalls = 0;
  intent.classifyIntentContext = async () => {
    classifierCalls += 1;
    return null;
  };
  const unregister = supportIntent.registerIntentOverride(async () => ({ verdict: intent.HELP_NEEDED, addressedToPixie: false, directedAtHuman: false, recentPixieParticipation: false, programRelevance: "relevant" }));
  try {
    const result = await supportIntent.classifySupportIntent("anything at all", null, {});
    assert.equal(result.shouldAttemptAnswer, true);
    assert.equal(classifierCalls, 0);
  } finally {
    unregister();
    intent.classifyIntentContext = real;
  }
  assert.equal(supportIntent.clearIntentOverrides(), undefined);
});
