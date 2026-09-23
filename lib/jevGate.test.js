process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const respond = require("./respond");
const jev = require("./jevDecision");
const lookup = require("./lookup");
const programs = require("./programs");

let originalEvaluate;

before(() => { originalEvaluate = jev.evaluateSupportDecision; });
after(() => { jev.evaluateSupportDecision = originalEvaluate; });

test("respond gate sends Jev intent context before retrieval and no evidence payload", async () => {
  const oldEnabled = process.env.JEV_ENABLED;
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  const oldCanary = process.env.JEV_CANARY_CHANNEL_IDS;
  process.env.JEV_ENABLED = "true";
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.JEV_CANARY_CHANNEL_IDS = "C-program";
  let received;
  jev.evaluateSupportDecision = async (value) => { received = value; return { action: "engage", reason: "jev_engage", decision: { intent: "support_question", shouldEngage: true } }; };
  try {
    const res = await respond.runJevGate({ effectiveQuestion: "what is restoration energy?", threadContext: "", prog: { id: "pixl", name: "Pixl" }, channel: "C-program", inHelpChannel: false, addressed: false });
    assert.equal(res.action, "engage");
    assert.deepEqual(Object.keys(received).sort(), ["addressed", "channelPosture", "conversationContext", "message", "program"]);
    assert.equal(received.channelPosture, "program");
  } finally {
    jev.evaluateSupportDecision = originalEvaluate;
    if (oldEnabled === undefined) delete process.env.JEV_ENABLED; else process.env.JEV_ENABLED = oldEnabled;
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldKey;
    if (oldCanary === undefined) delete process.env.JEV_CANARY_CHANNEL_IDS; else process.env.JEV_CANARY_CHANNEL_IDS = oldCanary;
  }
});

test("a Jev engagement permit does not bypass downstream grounding", () => {
  assert.equal(respond.isGroundedAnswer({ source: "Pixl Docs", answer: "Restoration Energy is documented." }), true);
  assert.equal(respond.isGroundedAnswer({ source: "NONE", answer: "made up answer" }), false);
});

test("normal program channel suppresses an ungrounded result after Jev engages", async () => {
  const oldEnabled = process.env.JEV_ENABLED;
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  const oldCanary = process.env.JEV_CANARY_CHANNEL_IDS;
  const originalLookup = lookup.answerOrChat;
  process.env.JEV_ENABLED = "true";
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.JEV_CANARY_CHANNEL_IDS = "C-normal";
  programs.saveProgram({ id: "jev-normal", name: "Jev Normal", posture: "passive", scope: "program", helpChannel: "C-help", channels: ["C-help", "C-normal"] });
  jev.evaluateSupportDecision = async () => ({ action: "engage", reason: "jev_engage", decision: { intent: "support_question", shouldEngage: true } });
  lookup.answerOrChat = async () => ({ source: "NONE", answer: "invented answer" });
  const posts = [];
  const client = { chat: { postMessage: async (value) => { posts.push(value); return { ts: "1" }; }, update: async () => ({}), delete: async () => ({}) }, reactions: { add: async () => ({}) } };
  try {
    const replied = await respond.respond({ client, channel: "C-normal", threadTs: "t-normal", userId: "U-requester", question: "what is my exact payout amount right now?", messageTs: "t-normal", mode: respond.HELP_ONLY });
    assert.equal(replied, false);
    assert.equal(posts.length, 0);
  } finally {
    lookup.answerOrChat = originalLookup;
    jev.evaluateSupportDecision = originalEvaluate;
    if (oldEnabled === undefined) delete process.env.JEV_ENABLED; else process.env.JEV_ENABLED = oldEnabled;
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldKey;
    if (oldCanary === undefined) delete process.env.JEV_CANARY_CHANNEL_IDS; else process.env.JEV_CANARY_CHANNEL_IDS = oldCanary;
  }
});

test("help channel sends a genuine unmentioned question through retrieval", async () => {
  const oldEnabled = process.env.JEV_ENABLED;
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  const oldCanary = process.env.JEV_CANARY_CHANNEL_IDS;
  const originalLookup = lookup.answerOrChat;
  process.env.JEV_ENABLED = "true";
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.JEV_CANARY_CHANNEL_IDS = "C-help";
  programs.saveProgram({ id: "jev-help", name: "Jev Help", posture: "passive", scope: "program", ticketsEnabled: false, helpChannel: "C-help", channels: ["C-help"] });
  programs.invalidate();
  jev.evaluateSupportDecision = async () => ({ action: "engage", reason: "jev_engage", decision: { intent: "support_question", shouldEngage: true } });
  let retrievalCalls = 0;
  lookup.answerOrChat = async () => { retrievalCalls += 1; return { source: "Jev Help Docs", answer: "a grounded answer" }; };
  const posts = [];
  const client = { chat: { postMessage: async (value) => { posts.push(value); return { ts: "1" }; }, update: async () => ({}), delete: async () => ({}) }, reactions: { add: async () => ({}) } };
  try {
    const replied = await respond.respond({ client, channel: "C-help", threadTs: "t-help", userId: "U-help-requester", question: "what is pixl?", messageTs: "t-help", mode: respond.HELP_ONLY });
    assert.equal(retrievalCalls, 1);
    assert.equal(replied, false);
    assert.equal(posts.length, 0);
  } finally {
    lookup.answerOrChat = originalLookup;
    jev.evaluateSupportDecision = originalEvaluate;
    if (oldEnabled === undefined) delete process.env.JEV_ENABLED; else process.env.JEV_ENABLED = oldEnabled;
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldKey;
    if (oldCanary === undefined) delete process.env.JEV_CANARY_CHANNEL_IDS; else process.env.JEV_CANARY_CHANNEL_IDS = oldCanary;
  }
});
