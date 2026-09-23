process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jev = require("./jevDecision");
const exo = require("./jevExperiential");

const CFG = { enabled: true, experientialApiKeyPresent: true, model: "jev-latest:free", baseUrl: "https://api.experientiallabs.ai/v1/systemone", timeoutMs: 8000, engageThreshold: 0.7 };
const INPUT = { message: "what is restoration energy?", conversationContext: "", program: { id: "pixl", name: "Pixl" }, channelPosture: "main" };
const response = (intent = "support_question", p = 0.95) => ({ model: "jev-latest:free", answers: { intent: { type: "choice", choice: intent, probabilities: { [intent]: p } }, shouldEngage: { type: "noul", noul: p } } });

beforeEach(() => jev.clearDecisionCache());

test("Experiential sends one free-lane intent-only request", async () => {
  const calls = [];
  const res = await jev.evaluateSupportDecision(INPUT, { config: CFG, httpPost: async (url, body) => { calls.push({ url, body }); return { status: 200, data: response() }; } });
  assert.equal(res.action, "engage");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "jev-latest:free");
  assert.deepEqual(Object.keys(calls[0].body.questions).sort(), ["intent", "shouldEngage"]);
});

test("adapter rejects undeclared intent choices", () => {
  const questions = jev.buildJevQuestions();
  assert.throws(() => exo.toInternalAnswers(questions, { intent: { type: "choice", choice: "made_up" }, shouldEngage: { type: "noul", noul: 0.9 } }));
});

test("quota makes exactly one request and surfaces error/quota, with no retry or fallback", async () => {
  let calls = 0;
  const res = await jev.evaluateSupportDecision(INPUT, { config: CFG, httpPost: async () => { calls += 1; return { status: 429, data: { error: { code: "free_limit_reached" } } }; } });
  assert.equal(calls, 1);
  assert.equal(res.action, "error");
  assert.equal(res.errorKind, "quota");
});

test("adapter refuses non-free models without touching the network", async () => {
  let calls = 0;
  await assert.rejects(
    exo.experientialEvaluate(
      { baseUrl: CFG.baseUrl, apiKey: "k", model: "typesafe-ai/jev", state: {}, questions: {} },
      { httpPost: async () => { calls += 1; return { status: 200, data: {} }; } },
    ),
    (err) => err && err.jevErrorKind === "config",
  );
  assert.equal(calls, 0);
});

test("adapter classifies 401 as auth with a single attempt", async () => {
  let calls = 0;
  await assert.rejects(
    exo.experientialEvaluate(
      { baseUrl: CFG.baseUrl, apiKey: "k", model: "jev-latest:free", state: {}, questions: jev.buildJevQuestions() },
      { httpPost: async () => { calls += 1; return { status: 401, data: { error: "unauthorized" } }; } },
    ),
    (err) => err && err.jevErrorKind === "auth",
  );
  assert.equal(calls, 1);
});

test("adapter classifies transport timeouts as timeout with a single attempt", async () => {
  let calls = 0;
  await assert.rejects(
    exo.experientialEvaluate(
      { baseUrl: CFG.baseUrl, apiKey: "k", model: "jev-latest:free", state: {}, questions: jev.buildJevQuestions() },
      { httpPost: async () => { calls += 1; throw Object.assign(new Error("timeout of 8000ms exceeded"), { code: "ECONNABORTED" }); } },
    ),
    (err) => err && err.jevErrorKind === "timeout",
  );
  assert.equal(calls, 1);
});

test("adapter never retries a 500: one call, unavailable", async () => {
  let calls = 0;
  await assert.rejects(
    exo.experientialEvaluate(
      { baseUrl: CFG.baseUrl, apiKey: "k", model: "jev-latest:free", state: {}, questions: jev.buildJevQuestions() },
      { httpPost: async () => { calls += 1; return { status: 500, data: {} }; } },
    ),
    (err) => err && err.jevErrorKind === "unavailable",
  );
  assert.equal(calls, 1);
});

test("free lane accepts the OpenCode Zen -free suffix and still refuses paid names", () => {
  const x = require("./jevExperiential");
  assert.equal(x.isFreeModel("jev-1.13-free"), true);
  assert.equal(x.isFreeModel("jev-latest:free"), true);
  assert.equal(x.isFreeModel("jev-1.13"), false);
  assert.equal(x.isFreeModel("jev-freestyle"), false);
});
