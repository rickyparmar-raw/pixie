process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const db = require("./db");
const respond = require("./respond");
const intent = require("./intent");
const lookup = require("./lookup");
const jevDecision = require("./jevDecision");
const answer = require("./answer");
const llm = require("./llm");

db.open(":memory:");

function fakeClient(posts) {
  return {
    chat: {
      postMessage: async (p) => { posts.push(p); return { ts: `msg-${posts.length}` }; },
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: { add: async () => ({}), remove: async () => ({}) },
  };
}

const PROG = {
  id: "jev-gate",
  name: "JevGate",
  posture: "active",
  scope: "any",
  helpChannel: "C-jev-gate",
  channels: ["C-jev-gate"],
  helperPing: true,
};

let realEvaluate;
let realClassify;
let realAnswerOrChat;
let realAnswerStream;
let realComplete;

before(() => {
  // programs.saveProgram (not db.saveProgram): test files share one process
  // and programs.all() caches, so the registry cache must be invalidated or
  // forChannel() resolves to the shared fallback and tickets file elsewhere.
  require("./programs").saveProgram(PROG);
  db.syncHelper({ programId: PROG.id, userId: "U-JEV-HELPER", source: "manual" });
  // Jev on with a dummy gateway key; the network call itself is stubbed per test.
  // The canary allowlist must include the test channel or runJevGate returns
  // the existing pipeline before any evaluation.
  process.env.JEV_ENABLED = "true";
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.JEV_CANARY_CHANNEL_IDS = "C-jev-gate";

  realEvaluate = jevDecision.evaluateSupportDecision;
  realClassify = intent.classifyIntentContext;
  realAnswerOrChat = lookup.answerOrChat;
  realAnswerStream = answer.getAnswerOrChatStream;
  realComplete = llm.complete;
  intent.classifyIntentContext = async () => ({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    directedAtHuman: false,
    recentPixieParticipation: false,
    programRelevance: "relevant",
    needsHelp: true,
    shouldAttemptAnswer: true,
  });
  llm.complete = async () => ({ text: "NONE", finishReason: "stop" });
});

after(() => {
  jevDecision.evaluateSupportDecision = realEvaluate;
  intent.classifyIntentContext = realClassify;
  lookup.answerOrChat = realAnswerOrChat;
  answer.getAnswerOrChatStream = realAnswerStream;
  llm.complete = realComplete;
  delete process.env.JEV_ENABLED;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.JEV_CANARY_CHANNEL_IDS;
});

function permit() {
  return {
    decision: {
      isSupportQuestion: true,
      documentationIsSufficient: true,
      shouldReply: true,
      needsHuman: false,
      risk: 1,
      confidence: {},
      probabilities: { isSupportQuestion: 0.98, documentationIsSufficient: 0.96, shouldReply: 0.97, needsHuman: 0.05 },
      source: "jev",
    },
    action: "reply",
    reason: "jev_permit",
    latencyMs: 5,
    errorKind: null,
  };
}

test("Case 9 — Jev permit lets the normal generator respond with citation intact", async () => {
  const posts = [];
  jevDecision.evaluateSupportDecision = async () => permit();
  lookup.answerOrChat = async () => ({ source: "JevGate Docs", answer: "the deadline is august 18" });
  answer.getAnswerOrChatStream = undefined;
  const { getAnswerOrChatStream } = require("./answer");
  void getAnswerOrChatStream;

  const replied = await respond.respond({
    client: fakeClient(posts),
    channel: "C-jev-gate",
    threadTs: "t-jev-permit",
    userId: "U-req-1",
    question: "when is the deadline for jevgate",
    mode: respond.HELP_ONLY,
  });
  assert.equal(replied, true);
  const said = posts.map((p) => p.text || "").join(" ");
  assert.match(said, /august 18/);
});

test("Case 7 — repeated uncertain events do not ping-storm", async () => {
  const posts = [];
  jevDecision.evaluateSupportDecision = async () => ({
    decision: {
      isSupportQuestion: true,
      documentationIsSufficient: false,
      shouldReply: false,
      needsHuman: true,
      risk: 5,
      confidence: {},
      probabilities: { isSupportQuestion: 0.95, documentationIsSufficient: 0.1, shouldReply: 0.05, needsHuman: 0.92 },
      source: "jev",
    },
    action: "escalate",
    reason: "jev_needs_human",
    latencyMs: 5,
    errorKind: null,
  });
  lookup.answerOrChat = async () => null;

  const ask = () => respond.respond({
    client: fakeClient(posts),
    channel: "C-jev-gate",
    threadTs: "t-jev-repeat",
    userId: "U-req-2",
    question: "what is the exact payout amount for jevgate",
    mode: respond.HELP_ONLY,
  });

  await ask();
  await ask();
  const pings = posts.filter((p) => /could you take a look/i.test(p.text || ""));
  assert.ok(pings.length <= 1, `expected at most one helper ping, got ${pings.length}`);
  const ticket = db.getTicketByThreadTs("t-jev-repeat", null, PROG.id);
  assert.ok(ticket, "exactly one ticket for the thread");
});

test("Jev deny stays silent outside the help channel", async () => {
  const posts = [];
  jevDecision.evaluateSupportDecision = async () => ({
    decision: {
      isSupportQuestion: false,
      documentationIsSufficient: false,
      shouldReply: false,
      needsHuman: false,
      risk: 5,
      confidence: {},
      probabilities: { isSupportQuestion: 0.02, documentationIsSufficient: 0.05, shouldReply: 0.01, needsHuman: 0.1 },
      source: "jev",
    },
    action: "silence",
    reason: "jev_deny",
    latencyMs: 5,
    errorKind: null,
  });
  lookup.answerOrChat = async () => ({ source: null, answer: "chatter" });

  const replied = await respond.respond({
    client: fakeClient(posts),
    channel: "C-jev-gate",
    threadTs: "t-jev-chatter",
    userId: "U-req-3",
    question: "lmao nice deploy",
    mode: respond.HELP_ONLY,
  });
  assert.equal(replied, false);
});

test("Jev outage escalates safely instead of answering", async () => {
  const posts = [];
  jevDecision.evaluateSupportDecision = async () => ({
    decision: { isSupportQuestion: false, documentationIsSufficient: false, shouldReply: false, needsHuman: true, risk: 5, confidence: {}, probabilities: {}, source: "fallback" },
    action: "escalate",
    reason: "jev_error_network",
    latencyMs: 5,
    errorKind: "network",
  });
  let generated = false;
  lookup.answerOrChat = async () => { generated = true; return { source: "Docs", answer: "made up" }; };

  const replied = await respond.respond({
    client: fakeClient(posts),
    channel: "C-jev-gate",
    threadTs: "t-jev-outage",
    userId: "U-req-4",
    question: "what is the payout amount",
    mode: respond.HELP_ONLY,
  });
  assert.equal(generated, false, "the generator must not run when Jev fails closed");
  assert.equal(replied, true);
});

test("Jev never selects arbitrary people — routing stays with configured helpers", async () => {
  const posts = [];
  jevDecision.evaluateSupportDecision = async () => ({
    decision: {
      isSupportQuestion: true,
      documentationIsSufficient: false,
      shouldReply: false,
      needsHuman: true,
      risk: 5,
      escalationTarget: "review",
      confidence: {},
      probabilities: { isSupportQuestion: 0.95, documentationIsSufficient: 0.1, shouldReply: 0.05, needsHuman: 0.9 },
      source: "jev",
    },
    action: "escalate",
    reason: "jev_needs_human",
    latencyMs: 5,
    errorKind: null,
  });
  lookup.answerOrChat = async () => null;

  await respond.respond({
    client: fakeClient(posts),
    channel: "C-jev-gate",
    threadTs: "t-jev-routing",
    userId: "U-req-5",
    question: "please review my thing urgently",
    mode: respond.HELP_ONLY,
  });
  const pings = posts.filter((p) => /could you take a look/i.test(p.text || ""));
  for (const p of pings) {
    assert.match(p.text, /U-JEV-HELPER/, "pings go to roster helpers only");
  }
});
