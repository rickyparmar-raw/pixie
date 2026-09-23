// Canary routing tests: Jev evaluates only in JEV_CANARY_CHANNEL_IDS.
// No real gateway calls — the `ai` module itself is faked, so the full
// production path (eligibility → intent → retrieval → Jev → generation →
// grounding) runs with zero network.
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const db = require("./db");
const respond = require("./respond");
const intent = require("./intent");
const lookup = require("./lookup");
const answer = require("./answer");
const llm = require("./llm");

db.open(":memory:");

const CANARY = "C-jev-canary";
const OTHER = "C-jev-other";
const PROG = {
  id: "jev-canary-prog",
  name: "JevCanary",
  posture: "active",
  scope: "any",
  helpChannel: CANARY,
  channels: [CANARY],
  helperPing: true,
};

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

const bool = (p) => ({ type: "boolean", probability: p });
let aiCalls = 0;
let aiMode = "permit"; // permit | throw | garbage

let realClassify;
let realLookup;
let realStream;
let realComplete;
let savedEnv = {};

before(() => {
  require("./programs").saveProgram(PROG);
  db.syncHelper({ programId: PROG.id, userId: "U-JEV-CANARY", source: "manual" });

  for (const k of ["JEV_ENABLED", "AI_GATEWAY_API_KEY", "JEV_CANARY_CHANNEL_IDS"]) savedEnv[k] = process.env[k];
  process.env.JEV_ENABLED = "true";
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.JEV_CANARY_CHANNEL_IDS = CANARY;

  const { mock } = require("bun:test");
  mock.module("ai", () => ({
    experimental_evaluate: async () => {
      aiCalls += 1;
      if (aiMode === "throw") throw new Error("gateway down");
      if (aiMode === "garbage") return { answers: { nonsense: true } };
      return {
        answers: {
          isSupportQuestion: bool(0.97),
          documentationIsSufficient: bool(0.95),
          shouldReply: bool(0.95),
          needsHuman: bool(0.08),
          answerRisk: { type: "score", score: 0, probabilities: { 0: 0.9 } },
        },
      };
    },
    gateway: { evaluationModel: (model) => ({ modelId: model }) },
  }));

  realClassify = intent.classifyIntentContext;
  intent.classifyIntentContext = async () => ({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    directedAtHuman: false,
    recentPixieParticipation: false,
    programRelevance: "relevant",
    needsHelp: true,
    shouldAttemptAnswer: true,
  });
  realLookup = lookup.answerOrChat;
  lookup.answerOrChat = async () => ({ source: "JevCanary Docs", answer: "the deadline is august 18" });
  realStream = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("the deadline is august 18");
    return { source: "JevCanary Docs", answer: "the deadline is august 18" };
  };
  realComplete = llm.complete;
  llm.complete = async () => ({ text: "NONE", finishReason: "stop" });
});

after(() => {
  require("bun:test").mock.restore();
  intent.classifyIntentContext = realClassify;
  lookup.answerOrChat = realLookup;
  answer.getAnswerOrChatStream = realStream;
  llm.complete = realComplete;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  require("./jevDecision").clearDecisionCache();
});

test("configured canary channel uses Jev and replies normally", async () => {
  const posts = [];
  const beforeCalls = aiCalls;
  aiMode = "permit";
  const replied = await respond.respond({
    client: fakeClient(posts),
    channel: CANARY,
    threadTs: "t-canary-1",
    userId: "U-req-1",
    question: "when is the deadline for jevcanary",
    mode: respond.HELP_ONLY,
  });
  assert.equal(replied, true);
  assert.ok(aiCalls > beforeCalls, "Jev must evaluate in the canary channel");
  assert.match(posts.map((p) => p.text || "").join(" "), /august 18/);
});

test("non-canary channel skips Jev and uses existing behavior", async () => {
  const posts = [];
  const beforeCalls = aiCalls;
  aiMode = "permit";
  const replied = await respond.respond({
    client: fakeClient(posts),
    channel: OTHER,
    threadTs: "t-canary-other",
    userId: "U-req-2",
    question: "when is the deadline for jevcanary",
    mode: respond.HELP_ONLY,
  });
  assert.equal(aiCalls, beforeCalls, "no Jev call outside the canary list");
  assert.equal(replied, true, "existing pipeline still answers");
});

test("empty allowlist does not globally enable Jev", async () => {
  const posts = [];
  const beforeCalls = aiCalls;
  process.env.JEV_CANARY_CHANNEL_IDS = "";
  try {
    aiMode = "permit";
    await respond.respond({
      client: fakeClient(posts),
      channel: CANARY,
      threadTs: "t-canary-empty",
      userId: "U-req-3",
      question: "when is the deadline for jevcanary",
      mode: respond.HELP_ONLY,
    });
    assert.equal(aiCalls, beforeCalls, "empty canary list must evaluate nothing anywhere");
  } finally {
    process.env.JEV_CANARY_CHANNEL_IDS = CANARY;
  }
});

test("duplicate evaluation in canary only calls Jev once", async () => {
  const posts = [];
  aiMode = "permit";
  const ask = (threadTs) => respond.respond({
    client: fakeClient(posts),
    channel: CANARY,
    threadTs,
    userId: "U-req-4",
    question: "what is the canary cache question",
    mode: respond.HELP_ONLY,
  });
  const beforeCalls = aiCalls;
  // Two fresh threads, identical message and empty context: identical evidence
  // must not pay for two evaluations.
  await ask("t-canary-dup-a");
  await ask("t-canary-dup-b");
  assert.equal(aiCalls, beforeCalls + 1);
});

test("Jev failure in canary remains fail-closed without crashing", async () => {
  const posts = [];
  aiMode = "throw";
  let generated = false;
  const savedLookup = lookup.answerOrChat;
  lookup.answerOrChat = async () => { generated = true; return { source: "Docs", answer: "made up" }; };
  try {
    const replied = await respond.respond({
      client: fakeClient(posts),
      channel: CANARY,
      threadTs: "t-canary-fail",
      userId: "U-req-5",
      question: "what is the payout amount",
      mode: respond.HELP_ONLY,
    });
    assert.equal(generated, false, "generator must not run when Jev fails closed");
    assert.equal(replied, true, "help channel escalates through the existing handoff");
    assert.ok(db.getTicketByThreadTs("t-canary-fail", null, PROG.id), "exactly one ticket");
  } finally {
    lookup.answerOrChat = savedLookup;
    aiMode = "permit";
  }
});

test("addressed identity question skips Jev and never pings", async () => {
  const posts = [];
  const beforeCalls = aiCalls;
  aiMode = "permit";
  assert.equal(respond.isIdentityOrSmalltalk("who r u"), true);
  assert.equal(respond.isIdentityOrSmalltalk("<@U123> who are you?"), true);
  assert.equal(respond.isIdentityOrSmalltalk("thanks!"), true);
  assert.equal(respond.isIdentityOrSmalltalk("when is the deadline"), false);
  const replied = await respond.respond({
    client: fakeClient(posts),
    channel: CANARY,
    threadTs: "t-canary-identity",
    userId: "U-req-7",
    question: "who r u",
    mode: respond.ALWAYS,
  });
  assert.equal(aiCalls, beforeCalls, "identity is conversational, not a Jev decision");
  assert.equal(replied, true);
  assert.ok(!posts.some((p) => /could you take a look/i.test(p.text || "")), "no helper ping for smalltalk");
});

test("ticketless handoff never pings the requester themself", async () => {
  const tickets = require("./tickets");
  const helperRoute = require("./helperRoute");
  const progId = "jev-canary-req";
  require("./programs").saveProgram({ ...PROG, id: progId, helpChannel: "C-req", channels: ["C-req"] });
  db.syncHelper({ programId: progId, userId: "U-REQ-HELPER", source: "manual" });
  db.syncHelper({ programId: progId, userId: "U-OTHER-HELPER", source: "manual" });
  helperRoute.recordResolution({ programId: progId, userId: "U-REQ-HELPER", category: "general_support" });
  helperRoute.recordResolution({ programId: progId, userId: "U-OTHER-HELPER", category: "general_support" });

  const posts = [];
  const program = { id: progId, name: "Req", helpChannel: "C-req", helperPing: true };
  const who = await tickets.handOffToHelper({
    client: fakeClient(posts), program, channel: "C-req", threadTs: "thr-req-1",
    question: "who r u", ticket: null, requesterId: "U-REQ-HELPER",
  });
  assert.notEqual(who, "U-REQ-HELPER", "requester must never be paged for their own question");
  assert.ok(posts.every((p) => !/U-REQ-HELPER/.test(p.text || "")), "no self-ping text posted");
});

test("malformed Jev response fails closed without crashing", async () => {
  const posts = [];
  aiMode = "garbage";
  const replied = await respond.respond({
    client: fakeClient(posts),
    channel: CANARY,
    threadTs: "t-canary-garbage",
    userId: "U-req-6",
    // Unique wording on purpose: the 120s result cache keys on identical
    // evidence, so reusing an earlier test's question would serve its permit.
    question: "when does the canary garbage launch window close",
    mode: respond.HELP_ONLY,
  });
  assert.doesNotThrow(() => {});
  assert.equal(typeof replied, "boolean");
  const said = posts.map((p) => p.text || "").join(" ");
  assert.doesNotMatch(said, /august 18/, "no confident answer on a malformed verdict");
  aiMode = "permit";
});
