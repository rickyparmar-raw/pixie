process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jev = require("./jevDecision");
const exo = require("./jevExperiential");

const CFG = { enabled: true, provider: "experiential", experientialApiKeyPresent: true, model: "jev-latest:free", baseUrl: "https://api.experientiallabs.ai/v1/systemone", timeoutMs: 8000, engageThreshold: 0.7 };
const INPUT = { message: "what is restoration energy?", conversationContext: "", program: { id: "pixl", name: "Pixl" }, channelPosture: "program" };
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

test("quota has no retry or provider fallback", async () => {
  let calls = 0;
  const res = await jev.evaluateSupportDecision(INPUT, { config: CFG, httpPost: async () => { calls += 1; return { status: 429, data: { error: { code: "free_limit_reached" } } }; } });
  assert.equal(calls, 1);
  assert.equal(res.action, "silence");
  assert.equal(res.errorKind, "quota");
});
