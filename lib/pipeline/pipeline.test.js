// End-to-end message pipeline regressions (spec §34/§35): real respond()
// orchestration, real channel policy and settings, stubbed classifier, answer
// model, tickets and Slack. Hermetic — no network, no Slack.
process.env.PIXIE_DB_PATH = ":memory:";

const { test, expect, beforeEach, beforeAll, afterAll } = require("bun:test");

const PIXL = {
  id: "pixl",
  name: "Pixl",
  scope: "program",
  helpChannel: "C_PIXL_HELP",
  channels: ["C_PIXL_HELP", "C_PIXL_MAIN"],
  ticketsEnabled: true,
  helperPing: true,
};
const B2B = {
  id: "back-to-basics",
  name: "Back to Basics",
  scope: "program",
  helpChannel: "C_B2B_HELP",
  channels: ["C_B2B_HELP", "C_B2B_MAIN"],
};

const db = require("../db");
const programs = require("../programs");
const jevDecision = require("../jevDecision");
const lookup = require("../lookup");
const tickets = require("../tickets");
const context = require("../context");
const guides = require("../guides");
const respond = require("../respond");

let savedEnv;
const saved = {};
function stub(obj, key, value) {
  if (!(key in saved)) saved[key] = [obj, obj[key]];
  obj[key] = value;
}

// Jev script: message text → classification.
const JEV = {
  "what is restoration energy?": { action: "engage", intent: "direct_program_question" },
  "what is pixl?": { action: "engage", intent: "direct_program_question" },
  "lmao gg": { action: "silence", intent: "unrelated_chatter" },
  "did you finish your game?": { action: "silence", intent: "human_conversation" },
  "does the hardware grant cover shipping?": { action: "engage", intent: "direct_program_question" },
  "what is my exact payout amount right now?": { action: "engage", intent: "direct_program_question" },
  "what is the exact maximum percentage of ai code allowed?": { action: "engage", intent: "direct_program_question" },
  "how do i do this": { action: "silence", intent: "ambiguous_followup" },
  "give me a chocolate chip cookie recipe": { action: "engage", intent: "addressed_general_request" },
  "my submission got rejected, how do i resubmit?": { action: "engage", intent: "support_question" },
  "how do i get my personal grant code?": { action: "engage", intent: "support_question" },
};

// Answer model script: grounded only where the program's docs support it.
function fakeAnswer(question, program) {
  const q = question.toLowerCase();
  if (q.includes("restoration energy") && program?.id === "pixl") {
    return { answer: "Restoration Energy is what you earn by restoring pixels.", source: "Pixl Docs" };
  }
  if (q === "what is pixl?" && program?.id === "pixl") return { answer: "Pixl is a YSWS for pixel art games.", source: "Pixl Docs" };
  if (q.includes("resubmit") && program?.id === "pixl") return { answer: "Fix the notes and resubmit from your dashboard.", source: "Pixl Docs" };
  if (q.includes("cookie")) return { answer: "Cream butter and sugar, add chips, bake at 180C.", source: "NONE" };
  // Everything else: the grounding boundary rejected any exact claim.
  return { answer: null, source: null, unclear: true };
}

let posts;
let ticketCalls;
let handOffs;
let jevCalls;
let answerCalls;
let jevMode;

function client() {
  return {
    chat: {
      postMessage: async (msg) => {
        posts.push(msg);
        return { ok: true, ts: `p${posts.length}` };
      },
      update: async (msg) => {
        posts.push({ ...msg, updated: true });
        return { ok: true, ts: msg.ts };
      },
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }) },
    conversations: { replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
  };
}

beforeAll(() => {
  savedEnv = process.env.PIXIE_PROGRAMS_JSON;
  db.open(":memory:");
});

afterAll(() => {
  for (const [key, [obj, value]] of Object.entries(saved)) obj[key] = value;
  if (savedEnv === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedEnv;
  programs.invalidate();
});

function configure(overrides = {}) {
  const pixl = { ...PIXL, ...(overrides.pixl || {}) };
  const b2b = { ...B2B, ...(overrides.b2b || {}) };
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([pixl, b2b]);
  programs.invalidate();
}

beforeEach(() => {
  configure();
  posts = [];
  ticketCalls = [];
  handOffs = [];
  jevCalls = [];
  answerCalls = [];
  jevMode = "script";
  stub(jevDecision, "isEnabled", () => true);
  stub(jevDecision, "evaluateSupportDecision", async (args) => {
    jevCalls.push(args);
    if (jevMode === "error") return { action: "error", errorKind: "timeout" };
    const hit = JEV[String(args.message).toLowerCase()];
    return hit ? { ...hit } : { action: "silence", intent: "unrelated_chatter" };
  });
  stub(lookup, "knownAnswer", () => null);
  stub(lookup, "answerOrChat", async (question, _ctx, opts) => {
    answerCalls.push({ question, program: opts.program?.id, allowWebSearch: opts.allowWebSearch });
    return fakeAnswer(question, opts.program);
  });
  stub(tickets, "ensureSupportTicket", async (args) => {
    ticketCalls.push(args);
    return { id: ticketCalls.length, status: "open" };
  });
  stub(tickets, "handOffToHelper", async (args) => {
    handOffs.push(args);
  });
  stub(tickets, "escalateTicket", async (args) => {
    handOffs.push({ ...args, sensitive: true });
  });
  stub(context, "seedFromSlack", async () => {});
  stub(guides, "detectGuideIntent", async () => null);
});

let seq = 0;
async function send({ channel, text, addressed = false, threadTs = null, messageTs = null }) {
  seq += 1;
  const ts = messageTs || `${1000 + seq}.000`;
  return respond.respond({
    client: client(),
    channel,
    threadTs: threadTs || ts,
    messageTs: ts,
    userId: `U_REQ_${seq}`,
    question: text,
    mode: addressed ? respond.ALWAYS : respond.HELP_ONLY,
    addressed,
  });
}

const postedText = () => posts.map((p) => p.text || "").join("\n");

/* ------------------------------------------------ main channel, ambient -- */

test("main ambient: a Pixl program question is classified, retrieved and answered", async () => {
  const spoke = await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?" });
  expect(spoke).toBe(true);
  expect(jevCalls).toHaveLength(1);
  expect(jevCalls[0].channelPosture).toBe("main");
  expect(answerCalls[0].program).toBe("pixl");
  expect(postedText()).toContain("Restoration Energy");
  expect(ticketCalls).toHaveLength(0);
});

test("main ambient: 'what is pixl?' answers from Pixl knowledge", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is pixl?" })).toBe(true);
  expect(postedText()).toContain("Pixl is a YSWS");
});

test("main ambient: another program's channel never reaches Pixl sources", async () => {
  const spoke = await send({ channel: "C_B2B_MAIN", text: "what is restoration energy?" });
  expect(answerCalls[0].program).toBe("back-to-basics");
  expect(spoke).toBe(false);
  expect(posts).toHaveLength(0);
});

for (const chatter of ["lmao gg", "did you finish your game?"]) {
  test(`main ambient: '${chatter}' stays silent with no retrieval, no ticket`, async () => {
    expect(await send({ channel: "C_PIXL_MAIN", text: chatter })).toBe(false);
    expect(answerCalls).toHaveLength(0);
    expect(ticketCalls).toHaveLength(0);
    expect(handOffs).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
}

test("main ambient: unsupported shipping question stays silent", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "does the hardware grant cover shipping?" })).toBe(false);
  expect(answerCalls).toHaveLength(1);
  expect(posts).toHaveLength(0);
  expect(handOffs).toHaveLength(0);
});

test("main ambient: exact payout is never fabricated — silence", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is my exact payout amount right now?" })).toBe(false);
  expect(posts).toHaveLength(0);
});

test("main ambient: exact AI-code percentage without evidence — silence, no number", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is the exact maximum percentage of AI code allowed?" })).toBe(false);
  expect(postedText()).not.toMatch(/\d+\s*%/);
});

test("main ambient: 'how do i do this' with no referent stays silent", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "how do i do this" })).toBe(false);
  expect(answerCalls).toHaveLength(0);
});

test("main ambient: 'how do i do this' with a clear thread referent retrieves and answers", async () => {
  // The classifier sees the bounded thread context and engages.
  stub(jevDecision, "evaluateSupportDecision", async (args) => {
    jevCalls.push(args);
    return /restoration energy/i.test(args.conversationContext)
      ? { action: "engage", intent: "ambiguous_followup" }
      : { action: "silence", intent: "ambiguous_followup" };
  });
  stub(lookup, "answerOrChat", async (question, ctx, opts) => {
    answerCalls.push({ question, program: opts.program?.id });
    return /restoration energy/i.test(ctx) ? { answer: "Restore pixels in the editor to earn it.", source: "Pixl Docs" } : { unclear: true };
  });
  context.addToThread("9000.000", "user", "what is restoration energy?", "U1", "C_PIXL_MAIN");
  const spoke = await send({ channel: "C_PIXL_MAIN", text: "how do i do this", threadTs: "9000.000", messageTs: "9000.100" });
  expect(jevCalls[0].conversationContext).toMatch(/restoration energy/i);
  expect(spoke).toBe(true);
  expect(postedText()).toContain("Restore pixels");
});

test("main ambient: classifier outage fails closed (silence)", async () => {
  jevMode = "error";
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?" })).toBe(false);
  expect(answerCalls).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("the classifier never receives documentation", async () => {
  await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?" });
  const keys = Object.keys(jevCalls[0]).sort();
  expect(keys).toEqual(["addressed", "channelPosture", "conversationContext", "message", "program"]);
});

/* ------------------------------------------------------ directly addressed -- */

test("addressed: program question gets the grounded answer", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
});

test("addressed: a cookie recipe gets a general-purpose answer", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "give me a chocolate chip cookie recipe", addressed: true })).toBe(true);
  expect(postedText()).toContain("butter");
  expect(answerCalls[0].allowWebSearch).toBe(true);
});

test("addressed: exact payout gets transparent uncertainty, never an amount", async () => {
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is my exact payout amount right now?", addressed: true })).toBe(true);
  expect(postedText()).toMatch(/couldn't verify/i);
  expect(postedText()).not.toMatch(/\$\s*\d|\d+\s*(?:usd|dollars)/i);
  expect(handOffs).toHaveLength(0);
});

test("addressed: program questions never use web search", async () => {
  await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?", addressed: true });
  expect(answerCalls[0].allowWebSearch).toBe(false);
});

test("addressed: classifier outage still responds, grounded or uncertain (never pretends)", async () => {
  jevMode = "error";
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
  posts = [];
  expect(await send({ channel: "C_PIXL_MAIN", text: "give me a chocolate chip cookie recipe", addressed: true })).toBe(true);
  expect(postedText()).toMatch(/couldn't verify/i);
});

test("addressed: 'who are you' needs no classifier call", async () => {
  stub(lookup, "answerOrChat", async () => ({ answer: "I'm Pixie!", source: "NONE" }));
  expect(await send({ channel: "C_PIXL_MAIN", text: "who are you?", addressed: true })).toBe(true);
  expect(jevCalls).toHaveLength(0);
});

/* ------------------------------------------------------------ help channel -- */

test("help: a known question opens a ticket and gets the grounded reply; ticket stays open", async () => {
  expect(await send({ channel: "C_PIXL_HELP", text: "my submission got rejected, how do i resubmit?" })).toBe(true);
  expect(ticketCalls).toHaveLength(1);
  expect(ticketCalls[0].role).toBe("help");
  expect(postedText()).toContain("resubmit");
  expect(handOffs).toHaveLength(0);
});

test("help: an unknown personal question opens a ticket and hands to a helper without hallucinating", async () => {
  expect(await send({ channel: "C_PIXL_HELP", text: "how do i get my personal grant code?" })).toBe(true);
  expect(ticketCalls).toHaveLength(1);
  expect(handOffs).toHaveLength(1);
  expect(handOffs[0].requesterId).toMatch(/^U_REQ_/);
  expect(posts).toHaveLength(0);
});

test("help: chatter creates no ticket and pings nobody", async () => {
  for (const t of ["lmao gg", "did you finish your game?"]) {
    await send({ channel: "C_PIXL_HELP", text: t });
  }
  expect(ticketCalls).toHaveLength(0);
  expect(handOffs).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("help: classifier outage preserves the support path (ticket + helper)", async () => {
  jevMode = "error";
  await send({ channel: "C_PIXL_HELP", text: "how do i get my personal grant code?" });
  expect(ticketCalls).toHaveLength(1);
  expect(handOffs).toHaveLength(1);
});

test("help: 'how do i do this' with no referent never fabricates", async () => {
  jevMode = "error";
  await send({ channel: "C_PIXL_HELP", text: "how do i do this" });
  expect(posts).toHaveLength(0);
  expect(handOffs).toHaveLength(1);
});

test("help: a thread reply does not open a second ticket", async () => {
  await send({ channel: "C_PIXL_HELP", text: "how do i get my personal grant code?", threadTs: "7000.000", messageTs: "7000.500" });
  expect(ticketCalls).toHaveLength(0);
});

/* ------------------------------------------------------ settings matrix -- */
// Decision-table coverage of every toggle that changes behavior (§35).

const MATRIX = [
  // [name, overrides, channel, text, addressed, expect {spoke, ticket, handoff, answerCalls}]
  ["main disabled: silent even when addressed", { main: { enabled: false } }, "C_PIXL_MAIN", "what is restoration energy?", true, { spoke: false, answer: 0 }],
  ["ambient off: ambient question silent, no classifier", { main: { ambientProgramReplies: false } }, "C_PIXL_MAIN", "what is restoration energy?", false, { spoke: false, answer: 0, jev: 0 }],
  ["ambient off: addressed still answered", { main: { ambientProgramReplies: false } }, "C_PIXL_MAIN", "what is restoration energy?", true, { spoke: true }],
  ["mention replies off: addressed silent", { main: { mentionReplies: false } }, "C_PIXL_MAIN", "what is restoration energy?", true, { spoke: false, answer: 0 }],
  ["general chat off: cookie treated as program fact → uncertainty", { main: { generalMentionChat: false } }, "C_PIXL_MAIN", "give me a chocolate chip cookie recipe", true, { spoke: true, text: /couldn't verify/i }],
  ["main escalation on: ambient unknown hands to helper", { main: { helperEscalationEnabled: true } }, "C_PIXL_MAIN", "does the hardware grant cover shipping?", false, { spoke: true, handoff: 1 }],
  ["help disabled: silent", { help: { enabled: false } }, "C_PIXL_HELP", "how do i get my personal grant code?", false, { spoke: false, ticket: 0, handoff: 0 }],
  ["help AI off: no model call, ticket + helper", { help: { aiReplies: false } }, "C_PIXL_HELP", "my submission got rejected, how do i resubmit?", false, { answer: 0, ticket: 1, handoff: 1 }],
  ["help escalate off: unknown stays silent, ticket still recorded", { help: { escalateUnknown: false } }, "C_PIXL_HELP", "how do i get my personal grant code?", false, { spoke: false, ticket: 1, handoff: 0 }],
  ["help escalate on: unknown handed off", {}, "C_PIXL_HELP", "how do i get my personal grant code?", false, { ticket: 1, handoff: 1 }],
];

for (const [name, behavior, channel, text, addressed, want] of MATRIX) {
  test(`matrix: ${name}`, async () => {
    configure({ pixl: { behavior } });
    const spoke = await send({ channel, text, addressed });
    if ("spoke" in want) expect(spoke).toBe(want.spoke);
    if ("ticket" in want) expect(ticketCalls).toHaveLength(want.ticket);
    if ("handoff" in want) expect(handOffs).toHaveLength(want.handoff);
    if ("answer" in want) expect(answerCalls).toHaveLength(want.answer);
    if ("jev" in want) expect(jevCalls).toHaveLength(want.jev);
    if (want.text) expect(postedText()).toMatch(want.text);
  });
}

test("paused program: silent in main and help, even when addressed", async () => {
  configure({ pixl: { status: "paused" } });
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?", addressed: true })).toBe(false);
  expect(await send({ channel: "C_PIXL_HELP", text: "how do i get my personal grant code?" })).toBe(false);
  expect(ticketCalls).toHaveLength(0);
  expect(jevCalls).toHaveLength(0);
});

test("sandbox program runs the same pipeline as live", async () => {
  configure({ pixl: { status: "sandbox" } });
  expect(await send({ channel: "C_PIXL_MAIN", text: "what is restoration energy?" })).toBe(true);
  expect(await send({ channel: "C_PIXL_HELP", text: "how do i get my personal grant code?" })).toBe(true);
  expect(handOffs).toHaveLength(1);
});

test("unclaimed channel: total silence even when addressed via message", async () => {
  expect(await send({ channel: "C_NOBODY", text: "what is restoration energy?" })).toBe(false);
  expect(jevCalls).toHaveLength(0);
});
