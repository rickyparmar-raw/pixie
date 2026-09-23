process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const jev = require("./jevDecision");
const exo = require("./jevExperiential");
const db = require("./db");

db.open(":memory:");

const EXO_CFG = {
  enabled: true,
  provider: "experiential",
  model: "jev-latest",
  baseUrl: "https://api.experientiallabs.ai/v1/systemone",
  timeoutMs: 8000,
  replyThreshold: 0.85,
  supportThreshold: 0.8,
  docsThreshold: 0.8,
  humanThreshold: 0.7,
  maxRisk: 2,
  zeroDataRetention: false,
  gatewayApiKeyPresent: false,
  experientialApiKeyPresent: true,
  canaryChannels: [],
};

const PROG = { id: "pixl", name: "Pixl", posture: "active", scope: "any" };
const INPUT = {
  message: "when is the deadline?",
  conversationContext: "",
  program: PROG,
  retrievedDocumentation: "### Pixl Docs\nThe deadline is August 18.",
  retrievalMetadata: {},
  currentIntent: "HELP_NEEDED",
  inHelpChannel: true,
};

const noul = (p) => ({ type: "noul", noul: p });

function nativeOk(overrides = {}) {
  return {
    model: "jev-latest",
    answers: {
      isSupportQuestion: noul(0.97),
      documentationIsSufficient: noul(0.95),
      shouldReply: noul(0.95),
      needsHuman: noul(0.08),
      answerRisk: { type: "score", score: 0, probabilities: { 0: 0.9, 1: 0.1 }, confidence: 0.9 },
      ...overrides,
    },
    usage: { input_tokens: 100, output_tokens: 0 },
  };
}

function fakePost(dataOrThrow, capture = null) {
  return async (url, body, opts) => {
    if (capture) capture.push({ url, body, opts });
    if (dataOrThrow instanceof Error) throw dataOrThrow;
    return { status: 200, data: dataOrThrow };
  };
}

beforeEach(() => {
  jev.clearDecisionCache();
});

test("noul booleans normalize into the shared SupportDecision", async () => {
  const res = await jev.evaluateSupportDecision(INPUT, { config: EXO_CFG, httpPost: fakePost(nativeOk()) });
  assert.equal(res.decision.source, "jev");
  assert.equal(res.decision.isSupportQuestion, true);
  assert.equal(res.decision.documentationIsSufficient, true);
  assert.equal(res.decision.shouldReply, true);
  assert.equal(res.decision.needsHuman, false);
  assert.equal(res.decision.risk, 1);
  assert.equal(res.action, "reply");
});

test("noul low probability denies without fabricating confidence", async () => {
  const res = await jev.evaluateSupportDecision(INPUT, {
    config: EXO_CFG,
    httpPost: fakePost(nativeOk({ documentationIsSufficient: noul(0.1), shouldReply: noul(0.05), needsHuman: noul(0.92), answerRisk: { type: "score", score: 4, probabilities: { 4: 1 } } })),
  });
  assert.equal(res.decision.documentationIsSufficient, false);
  assert.equal(res.action, "escalate");
});

test("choice escalationTarget uses only configured categories", async () => {
  const questions = jev.buildJevQuestions({ escalationCategories: ["billing", "review"] });
  assert.ok(questions.escalationTarget);
  assert.equal(questions.escalationTarget.type, "choice");
  const res = await jev.evaluateSupportDecision(INPUT, {
    config: EXO_CFG,
    questions,
    httpPost: fakePost(nativeOk({ escalationTarget: { type: "choice", choice: "review", probabilities: { billing: 0.2, review: 0.8 }, confidence: 0.8 } })),
  });
  assert.equal(res.decision.escalationTarget, "review");
});

test("score maps 0..4 to risk 1..5", async () => {
  for (const [score, risk] of [[0, 1], [2, 3], [4, 5]]) {
    // Distinct messages: the result cache keys on identical evidence.
    const res = await jev.evaluateSupportDecision({ ...INPUT, message: `risk probe ${score}` }, {
      config: EXO_CFG,
      httpPost: fakePost(nativeOk({ answerRisk: { type: "score", score, probabilities: { [score]: 1 } } })),
    });
    assert.equal(res.decision.risk, risk, `score ${score} should be risk ${risk}`);
  }
});

test("risk_1 through risk_5 normalize to risk 1..5 with real confidence", async () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const res = await jev.evaluateSupportDecision({ ...INPUT, message: `risk choice probe ${n}` }, {
      config: EXO_CFG,
      httpPost: fakePost(nativeOk({ answerRisk: { type: "choice", choice: `risk_${n}`, probabilities: { [`risk_${n}`]: 0.8 }, confidence: 0.8 } })),
    });
    assert.equal(res.decision.risk, n, `risk_${n} should be risk ${n}`);
    assert.equal(res.decision.confidence.risk, 0.8, "selected-choice probability preserved as confidence");
  }
});

test("undeclared risk choice values fail closed", async () => {
  for (const choice of ["risk_0", "risk_6", "medium", "1", ""]) {
    const res = await jev.evaluateSupportDecision(INPUT, {
      config: EXO_CFG,
      httpPost: fakePost(nativeOk({ answerRisk: { type: "choice", choice, probabilities: {} } })),
    });
    assert.equal(res.decision.source, "fallback", `choice ${JSON.stringify(choice)} must fail closed`);
    assert.notEqual(res.action, "reply");
  }
});

test("missing risk probability does not create fake confidence", async () => {
  const res = await jev.evaluateSupportDecision(INPUT, {
    config: EXO_CFG,
    httpPost: fakePost(nativeOk({ answerRisk: { type: "choice", choice: "risk_2" } })),
  });
  assert.equal(res.decision.risk, 2);
  assert.equal(res.decision.confidence.risk, undefined);
});

test("normal Experiential evaluation sends no native score question", async () => {
  const calls = [];
  const questions = jev.buildJevQuestions({ escalationCategories: ["billing", "review"] });
  await jev.evaluateSupportDecision(INPUT, { config: EXO_CFG, questions, httpPost: fakePost(nativeOk({
    escalationTarget: { type: "choice", choice: "review", probabilities: { billing: 0.2, review: 0.8 } },
    answerRisk: { type: "choice", choice: "risk_1", probabilities: { risk_1: 0.9 } },
  }), calls) });
  assert.equal(calls.length, 1);
  const sent = Object.values(calls[0].body.questions);
  assert.ok(sent.length > 0);
  assert.ok(sent.every((q) => q.type === "noul" || q.type === "choice"), "only noul and choice on the wire");
  assert.ok(!sent.some((q) => q.type === "score"), "no native score emitted");
  const riskQ = calls[0].body.questions.answerRisk;
  assert.equal(riskQ.type, "choice");
  assert.deepEqual(riskQ.criteria, exo.RISK_CHOICE_CRITERIA);
});

test("jev-latest:free model id passes through unchanged, single attempt on failure", async () => {
  const calls = [];
  const cfg = { ...EXO_CFG, model: "jev-latest:free" };
  const err = new Error("bad gateway");
  err.response = { status: 502, data: {} };
  const res = await jev.evaluateSupportDecision(INPUT, {
    config: cfg,
    httpPost: async (url, body, opts) => { calls.push({ url, body }); throw err; },
  });
  assert.equal(calls.length, 1, "exactly one attempt, no retry");
  assert.equal(calls[0].body.model, "jev-latest:free");
  assert.equal(res.errorKind, "unavailable");
  assert.notEqual(res.action, "reply");
});

test("quota exhaustion fails closed with kind quota", async () => {
  const quotaBody = { error: { code: "free_limit_reached", message: "free lane exhausted" } };
  const res = await jev.evaluateSupportDecision(INPUT, { config: EXO_CFG, httpPost: async () => ({ status: 429, data: quotaBody }) });
  assert.equal(res.decision.source, "fallback");
  assert.equal(res.errorKind, "quota");
  assert.equal(res.action, "escalate");
});

test("insufficient_quota and promotion-ended fail closed", async () => {
  for (const data of [
    { error: { code: "insufficient_quota" } },
    { error: { message: "promotion ended, top up to continue" } },
  ]) {
    const err = new Error("request failed");
    err.response = { status: 402, data };
    const res = await jev.evaluateSupportDecision(INPUT, {
      config: EXO_CFG,
      httpPost: async () => { throw err; },
    });
    assert.equal(res.errorKind, "quota", JSON.stringify(data));
    assert.notEqual(res.action, "reply");
  }
});

test("rate limit fails closed", async () => {
  const err = new Error("too many");
  err.response = { status: 429, data: { error: "slow down" } };
  const res = await jev.evaluateSupportDecision(INPUT, { config: EXO_CFG, httpPost: async () => { throw err; } });
  assert.equal(res.errorKind, "rate_limit");
  assert.equal(res.action, "escalate");
});

test("auth failure fails closed", async () => {
  const err = new Error("denied");
  err.response = { status: 401, data: {} };
  const res = await jev.evaluateSupportDecision(INPUT, { config: EXO_CFG, httpPost: async () => { throw err; } });
  assert.equal(res.errorKind, "auth");
  assert.notEqual(res.action, "reply");
});

test("malformed responses fail closed", async () => {
  const bad = [
    {},
    { answers: null },
    { answers: { isSupportQuestion: { type: "noul" } } },
    { answers: { isSupportQuestion: { type: "noul", noul: 2 } } },
    { answers: { isSupportQuestion: { type: "choice", choice: "x", probabilities: {} } } },
    { answers: { isSupportQuestion: noul(0.9), documentationIsSufficient: noul(0.9), shouldReply: noul(0.9), needsHuman: noul(0.1), answerRisk: { type: "score", score: 9, probabilities: {} } } },
  ];
  for (const data of bad) {
    const res = await jev.evaluateSupportDecision(INPUT, { config: EXO_CFG, httpPost: fakePost(data) });
    assert.equal(res.decision.source, "fallback", JSON.stringify(data).slice(0, 80));
    assert.notEqual(res.action, "reply");
  }
});

test("timeouts fail closed", async () => {
  const err = new Error("timeout of 8000ms exceeded");
  err.code = "ECONNABORTED";
  const res = await jev.evaluateSupportDecision(INPUT, { config: EXO_CFG, httpPost: async () => { throw err; } });
  assert.equal(res.errorKind, "timeout");
  assert.notEqual(res.action, "reply");
});

test("no Vercel/paid fallback: experiential mode never touches the ai SDK or another URL", async () => {
  const { mock } = require("bun:test");
  mock.module("ai", () => new Proxy({}, { get() { throw new Error("vercel SDK touched"); } }));
  const calls = [];
  try {
    const res = await jev.evaluateSupportDecision(INPUT, {
      config: EXO_CFG,
      httpPost: fakePost(nativeOk(), calls),
    });
    assert.equal(res.action, "reply");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, EXO_CFG.baseUrl);
    assert.equal(calls[0].body.model, "jev-latest");
    assert.equal(calls[0].body.questions.isSupportQuestion.type, "noul");
    const serialized = JSON.stringify({ body: calls[0].body, opts: { timeoutMs: calls[0].opts.timeoutMs } });
    assert.doesNotMatch(serialized, /zeroDataRetention|Bearer|sk-|gateway/i);
  } finally {
    mock.restore();
  }
});

test("experiential enablement requires its own key, not the gateway key", () => {
  assert.equal(jev.providerOf({ provider: "experiential" }), "experiential");
  assert.equal(jev.providerKeyPresent({ provider: "experiential", experientialApiKeyPresent: true }), true);
  assert.equal(jev.providerKeyPresent({ provider: "experiential", experientialApiKeyPresent: false, gatewayApiKeyPresent: true }), false);
  assert.equal(jev.providerKeyPresent({ provider: "vercel", gatewayApiKeyPresent: true }), true);
  assert.equal(jev.isEnabled({ enabled: true, provider: "experiential", experientialApiKeyPresent: false, gatewayApiKeyPresent: true }), false);
});
