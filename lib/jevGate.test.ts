process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jev = require("./jevDecision");

// These cases exercise the flat gate contract consumed by the response orchestrator.
// Inputs deliberately omit documentation and evidence because the gate only judges engagement intent.
const CFG = {
  enabled: true,
  experientialApiKeyPresent: true,
  model: "jev-latest:free",
  baseUrl: "https://api.experientiallabs.ai/v1/systemone",
  timeoutMs: 8000,
  engageThreshold: 0.7,
};
const GATE_INPUT = {
  message: "what is restoration energy?",
  conversationContext: "",
  program: { id: "pixl", name: "Pixl" },
  channelPosture: "main",
  addressed: false,
};
const verdict = (intent: any, p: any) => ({
  answers: {
    intent: { type: "choice", choice: intent, probabilities: { [intent]: p } },
    shouldEngage: { type: "boolean", probability: p },
  },
});

beforeEach(() => jev.clearDecisionCache());

test("gate returns the flat classifier contract", async () => {
  const res = await jev.evaluateSupportDecision(GATE_INPUT, {
    config: CFG,
    evaluateFn: async () => verdict("support_question", 0.95),
  });
  assert.deepEqual(Object.keys(res).sort(), ["action", "errorKind", "intent", "latencyMs", "reason", "shouldEngageP"]);
  assert.equal(res.action, "engage");
  assert.equal(typeof res.latencyMs, "number");
});

test("gate input carries intent context only: no documentation, no evidence payload", async () => {
  let received: any;
  await jev.evaluateSupportDecision(
    { ...GATE_INPUT, channelPosture: "dm", addressed: true },
    {
      config: CFG,
      evaluateFn: async (args: any) => {
        received = args;
        return verdict("support_question", 0.95);
      },
    },
  );
  assert.deepEqual(Object.keys(received.state).sort(), [
    "addressed",
    "channelPosture",
    "conversationContext",
    "message",
    "program",
  ]);
  assert.equal(received.state.channelPosture, "dm");
  assert.equal(received.state.addressed, true);
  assert.deepEqual(received.state.program, { id: "pixl", name: "Pixl" });
  assert.doesNotMatch(JSON.stringify(received.state), /document|evidence|corpus/i);
});

test("gate error verdict leaves terminal routing to the orchestrator", async () => {
  const res = await jev.evaluateSupportDecision(GATE_INPUT, {
    config: CFG,
    evaluateFn: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(res.action, "error");
  assert.ok(res.errorKind);
  assert.notEqual(res.action, "escalate");
  assert.notEqual(res.action, "silence");
});
export {};
