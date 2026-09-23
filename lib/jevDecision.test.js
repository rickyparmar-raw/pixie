process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jev = require("./jevDecision");

const CFG = { enabled: true, gatewayApiKeyPresent: true, model: "typesafe-ai/jev", timeoutMs: 8000, engageThreshold: 0.7 };
const PROGRAM = { id: "pixl", name: "Pixl", posture: "passive", scope: "program" };
const input = (message, extra = {}) => ({ message, conversationContext: "", program: PROGRAM, channelPosture: "program", ...extra });
const result = (intent, p) => ({ answers: { intent: { type: "choice", choice: intent, probabilities: { [intent]: p } }, shouldEngage: { type: "boolean", probability: p } } });

beforeEach(() => jev.clearDecisionCache());

test("Jev asks only for typed engagement intent", () => {
  const questions = jev.buildJevQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["intent", "shouldEngage"]);
  assert.deepEqual(Object.keys(questions.intent.criteria).sort(), Object.keys(jev.INTENT_CHOICES).sort());
  assert.doesNotMatch(JSON.stringify(questions), /documentationIsSufficient|answerRisk|needsHuman/);
});

test("clear program questions engage without retrieved documentation", async () => {
  const res = await jev.evaluateSupportDecision(input("what is restoration energy?"), { config: CFG, evaluateFn: async () => result("direct_program_question", 0.96) });
  assert.equal(res.action, "engage");
  assert.equal(res.decision.intent, "direct_program_question");
  assert.equal(res.decision.shouldEngage, true);
});

test("chatter and human conversation stay silent", async () => {
  for (const [message, intent] of [["lmao gg", "unrelated_chatter"], ["did you finish your game?", "human_conversation"]]) {
    const res = await jev.evaluateSupportDecision(input(message), { config: CFG, evaluateFn: async () => result(intent, 0.02) });
    assert.equal(res.action, "silence", message);
  }
});

test("ambiguous follow-ups require a clear context referent", async () => {
  const unclear = await jev.evaluateSupportDecision(input("how do i do this"), { config: CFG, evaluateFn: async () => result("ambiguous_followup", 0.12) });
  const clear = await jev.evaluateSupportDecision(input("how do i do this", { conversationContext: "human: how do I submit a Pixl project?" }), { config: CFG, evaluateFn: async () => result("ambiguous_followup", 0.91) });
  assert.equal(unclear.action, "silence");
  assert.equal(clear.action, "engage");
});

test("errors fail closed by channel posture", async () => {
  const fail = async () => { throw new Error("fetch failed"); };
  assert.equal((await jev.evaluateSupportDecision(input("what is pixl?"), { config: CFG, evaluateFn: fail })).action, "silence");
  assert.equal((await jev.evaluateSupportDecision(input("what is pixl?", { channelPosture: "help" }), { config: CFG, evaluateFn: fail })).action, "escalate");
});
