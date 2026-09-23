process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const jev = require("./jevDecision");
const db = require("./db");

db.open(":memory:");

const CFG = {
  enabled: true,
  gatewayApiKeyPresent: true,
  model: "typesafe-ai/jev",
  timeoutMs: 8000,
  replyThreshold: 0.9,
  supportThreshold: 0.8,
  docsThreshold: 0.85,
  humanThreshold: 0.7,
  maxRisk: 2,
  zeroDataRetention: true,
};

function bool(p) {
  return { type: "boolean", probability: p };
}

function stubResult({ support = 0.98, docs = 0.96, reply = 0.97, human = 0.06, riskScore = 0 } = {}) {
  return {
    answers: {
      isSupportQuestion: bool(support),
      documentationIsSufficient: bool(docs),
      shouldReply: bool(reply),
      needsHuman: bool(human),
      answerRisk: { type: "score", score: riskScore, probabilities: { [String(riskScore)]: 0.9 } },
    },
  };
}

const PROG = { id: "pixl", name: "Pixl", posture: "active", scope: "any" };
const BASE_INPUT = {
  message: "when is the deadline?",
  conversationContext: "",
  program: PROG,
  retrievedDocumentation: "### Pixl Docs\nThe deadline is August 18.",
  retrievalMetadata: { corpusChars: 40 },
  currentIntent: "HELP_NEEDED",
  inHelpChannel: true,
};

beforeEach(() => {
  delete process.env.JEV_ENABLED;
  jev.clearDecisionCache();
});

function withFakeAi(fakeEvaluate) {
  const { mock } = require("bun:test");
  mock.module("ai", () => ({
    experimental_evaluate: fakeEvaluate,
    gateway: { evaluationModel: (model) => ({ modelId: model }) },
  }));
  return () => {
    mock.restore();
    jev.clearDecisionCache();
  };
}

test("Case 1 — clearly answerable permits answering", async () => {
  const res = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => stubResult(),
  });
  assert.equal(res.decision.source, "jev");
  assert.equal(res.action, "reply");
  assert.equal(res.decision.isSupportQuestion, true);
  assert.equal(res.decision.documentationIsSufficient, true);
  assert.equal(res.decision.risk, 1);
});

test("Case 2 — missing docs never permits a fabricated answer", async () => {
  const res = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => stubResult({ docs: 0.1, reply: 0.05, human: 0.92, riskScore: 4 }),
  });
  assert.equal(res.decision.documentationIsSufficient, false);
  assert.notEqual(res.action, "reply");
  assert.equal(res.action, "escalate");
});

test("Case 3 — random Slack conversation stays silent", async () => {
  const res = await jev.evaluateSupportDecision(
    { ...BASE_INPUT, message: "lmao that deploy was wild", retrievedDocumentation: "### Pixl Docs\ndeadline august 18" },
    { config: CFG, evaluateFn: async () => stubResult({ support: 0.02, docs: 0.05, reply: 0.01, human: 0.1, riskScore: 4 }) },
  );
  assert.equal(res.decision.isSupportQuestion, false);
  assert.equal(res.action, "silence");
});

test("Case 4 — ambiguous question does not confidently answer", async () => {
  const res = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => stubResult({ support: 0.85, docs: 0.55, reply: 0.5, human: 0.6, riskScore: 2 }),
  });
  assert.notEqual(res.action, "reply");
});

test("Case 5 — conflicting docs escalate", async () => {
  const res = await jev.evaluateSupportDecision(
    { ...BASE_INPUT, retrievedDocumentation: "### A\ndeadline Aug 18\n### B\ndeadline Sept 1" },
    { config: CFG, evaluateFn: async () => stubResult({ docs: 0.3, reply: 0.2, human: 0.9, riskScore: 3 }) },
  );
  assert.equal(res.decision.needsHuman, true);
  assert.equal(res.action, "escalate");
});

test("Case 6 — Jev unavailable fails closed without crashing", async () => {
  const help = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => { throw new Error("fetch failed"); },
  });
  assert.equal(help.decision.source, "fallback");
  assert.equal(help.action, "escalate");
  assert.ok(help.errorKind);

  const elsewhere = await jev.evaluateSupportDecision(
    { ...BASE_INPUT, inHelpChannel: false },
    { config: CFG, evaluateFn: async () => { throw new Error("fetch failed"); } },
  );
  assert.equal(elsewhere.action, "silence");

  const timeout = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
  });
  assert.equal(timeout.errorKind, "timeout");
  assert.notEqual(timeout.action, "reply");
});

test("disabled Jev leaves the existing pipeline in charge", async () => {
  let called = false;
  const res = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: { ...CFG, enabled: false },
    evaluateFn: async () => { called = true; return stubResult(); },
  });
  assert.equal(res.action, "existing");
  assert.equal(res.decision.source, "existing");
  assert.equal(called, false);
});

test("Case 8 — thread context is kept separate from documentation", () => {
  const state = jev.buildJevState({
    message: "and what about the second step?",
    conversationContext: "human: how do i submit?\npixie: through the portal",
    program: PROG,
    retrievedDocumentation: "### Pixl Docs\nSubmit through the portal by Aug 18.",
    retrievalMetadata: {},
    currentIntent: "HELP_NEEDED",
  });
  assert.match(state.conversationContext, /how do i submit/);
  assert.match(state.retrievedDocumentation, /Submit through the portal/);
  assert.notEqual(state.conversationContext, state.retrievedDocumentation);
});

test("missing probabilities are not faked and deny reply", async () => {
  const res = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => ({
      answers: {
        isSupportQuestion: { type: "boolean" },
        documentationIsSufficient: { type: "boolean" },
        shouldReply: { type: "boolean" },
        needsHuman: { type: "boolean" },
        answerRisk: { type: "score" },
      },
    }),
  });
  assert.deepEqual(res.decision.confidence, {});
  assert.notEqual(res.action, "reply");
});

test("thresholds are configurable, not magic constants", async () => {
  const borderline = { support: 0.85, docs: 0.86, reply: 0.85, human: 0.1, riskScore: 1 };
  const strict = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => stubResult(borderline),
  });
  assert.notEqual(strict.action, "reply");
  const loose = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: { ...CFG, replyThreshold: 0.8, supportThreshold: 0.8, docsThreshold: 0.8 },
    evaluateFn: async () => stubResult(borderline),
  });
  assert.equal(loose.action, "reply");
});

test("risk above the maximum blocks reply", async () => {
  const res = await jev.evaluateSupportDecision(BASE_INPUT, {
    config: CFG,
    evaluateFn: async () => stubResult({ riskScore: 2 }),
  });
  assert.equal(res.decision.risk, 3);
  assert.notEqual(res.action, "reply");
});

test("escalation choice only uses existing configured categories", () => {
  const withCats = jev.buildJevQuestions({ escalationCategories: ["billing", "review", "billing"] });
  assert.ok(withCats.escalationTarget);
  assert.deepEqual(Object.keys(withCats.escalationTarget.criteria).sort(), ["billing", "review"]);
  const withoutCats = jev.buildJevQuestions({ escalationCategories: [] });
  assert.equal(withoutCats.escalationTarget, undefined);
  const single = jev.buildJevQuestions({ escalationCategories: ["only-one"] });
  assert.equal(single.escalationTarget, undefined);
});

test("repeat identical evaluation is served from short-lived cache (one gateway call)", async () => {
  let calls = 0;
  const restore = withFakeAi(async () => { calls += 1; return stubResult(); });
  try {
    const statsBefore = jev.getStats();
    const r1 = await jev.evaluateSupportDecision(BASE_INPUT, { config: CFG });
    const r2 = await jev.evaluateSupportDecision(BASE_INPUT, { config: CFG });
    assert.equal(calls, 1);
    assert.equal(r1.action, "reply");
    assert.equal(r2.action, "reply");
    assert.equal(r2.cached, true);
    assert.equal(jev.getStats().cacheHits, statsBefore.cacheHits + 1);
  } finally {
    restore();
  }
});

test("failures are never cached and stay fail-closed", async () => {
  let calls = 0;
  const restore = withFakeAi(async () => { calls += 1; throw new Error("fetch failed"); });
  try {
    const r1 = await jev.evaluateSupportDecision(BASE_INPUT, { config: CFG });
    const r2 = await jev.evaluateSupportDecision(BASE_INPUT, { config: CFG });
    assert.equal(calls, 2);
    assert.equal(r1.decision.source, "fallback");
    assert.equal(r2.decision.source, "fallback");
    assert.equal(r1.cached, undefined);
  } finally {
    restore();
  }
});

test("state is bounded and carries no huge histories", () => {
  const state = jev.buildJevState({
    message: "x".repeat(5000),
    conversationContext: "y".repeat(5000),
    program: PROG,
    retrievedDocumentation: "z".repeat(20000),
    retrievalMetadata: { a: 1 },
    currentIntent: "HELP_NEEDED",
  });
  assert.ok(state.message.length <= jev.MAX_MESSAGE_CHARS + 40);
  assert.ok(state.conversationContext.length <= jev.MAX_CONTEXT_CHARS + 40);
  assert.ok(state.retrievedDocumentation.length <= jev.MAX_DOCS_CHARS + 40);
  assert.deepEqual(Object.keys(state.program).sort(), ["id", "name", "posture", "scope"]);
});
