// Contextual program-question parity matrix.
//
// Regression class: a short question asked inside a program channel must be
// understood against that program's docs ("what are tiers, explain them" in a
// Hardwire channel means Hardwire tiers) without repeating the program name —
// and must never leak another program's docs into the answer.
//
// These tests pin the invariant at three levels so the FIRST divergence is
// visible, not just the final reply:
//   1. retrievalQuery construction (program context folded into the query),
//   2. corpus scoping (the program's evidence is present, others' absent),
//   3. end-to-end disposition via respond() (reply vs silence vs fallback).
//
// Fixture programs use inline text sources so no network is touched. The model
// is scripted with fixed per-question SOURCE/ANSWER pairs (test data, not
// implementation): retrieval assertions use the real pipeline, disposition
// assertions verify the pipeline delivers the scripted answer unchanged.
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const llm = require("./llm");
const lookup = require("./lookup");
const knowledge = require("./knowledge");
const programs = require("./programs");
const respond = require("./respond");
const intent = require("./intent");

db.open(":memory:");

const HW_DOCS = `## Tiers
Hardwire has three tiers. Tier 1 is for first-time builders: blink an LED and write a short reflection. Tier 2 is the main build: design a custom PCB, get it fabricated, assemble it, and demo working firmware. Tier 3 is the stretch goal: add wireless connectivity and publish full documentation.
## Getting started
To start Hardwire, pick a tier, join the Hardwire channel, and tell a helper which tier you are aiming for.
## Rewards
Tier 1 earns a sticker pack. Tier 2 earns a microcontroller devboard. Tier 3 earns a full hardware kit.
## Hardware requirements
Every Hardwire build needs a microcontroller, a breadboard for prototyping, and access to a soldering iron for final assembly.
## Software requirements
Hardwire firmware is written in C or MicroPython. Use any editor, but keep your source in git from day one.`;

const PIXL_DOCS = `## Submission
To submit your Pixl project, push your code to GitHub, record a demo video, and fill out the submission form before the deadline.
## README
Your README must explain what you built, how to run it, and include a screenshot. Repos must be public.
## Returned projects
If your project is returned, read the reviewer feedback carefully, make the requested changes, and resubmit before the deadline.
## AI policy
AI tools may write at most 30 percent of your code. Disclose AI use in your README or your payout is deflated.`;

const OTHER_DOCS = `## Mascot
The Other program's mascot is a purple platypus named Plax.`;

const HW = {
  id: "ctx-hw",
  name: "Hardwire",
  sharedSources: false,
  helpChannel: "C-HW-HELP",
  channels: ["C-HW"],
  sources: [{ name: "Hardwire Docs", type: "text", content: HW_DOCS }],
};
const PIXL = {
  id: "ctx-pixl",
  name: "Pixl",
  sharedSources: false,
  helpChannel: "C-PIXL-HELP",
  channels: ["C-PIXL"],
  sources: [{ name: "Pixl Docs", type: "text", content: PIXL_DOCS }],
};
const OTHER = {
  id: "ctx-other",
  name: "Other",
  sharedSources: false,
  helpChannel: "C-OTHER-HELP",
  channels: ["C-OTHER"],
  sources: [{ name: "Other Docs", type: "text", content: OTHER_DOCS }],
};

// Canned model outputs keyed by normalized question. The model is scripted;
// what matters is that the pipeline delivers these unchanged (or stays
// silent), scoped to the asking program.
const SCRIPTED = new Map([
  ["what are tiers, explain them", "SOURCE: Hardwire Docs\nANSWER: Hardwire has three tiers: Tier 1 blink an LED, Tier 2 build a custom PCB, Tier 3 add wireless."],
  ["what do you do in each tier?", "SOURCE: Hardwire Docs\nANSWER: Tier 1 blink an LED, Tier 2 design and assemble a custom PCB, Tier 3 add wireless and docs."],
  ["what about tier 2?", "SOURCE: Hardwire Docs\nANSWER: Tier 2 is the main build: custom PCB, fabricated and assembled, with demo firmware."],
  ["how do i start?", "SOURCE: Hardwire Docs\nANSWER: Pick a tier, join the Hardwire channel, and tell a helper which tier you aim for."],
  ["what rewards do i get?", "SOURCE: Hardwire Docs\nANSWER: Tier 1 sticker pack, Tier 2 devboard, Tier 3 full hardware kit."],
  ["how do i submit?", "SOURCE: Pixl Docs\nANSWER: Push to GitHub, record a demo video, and fill the submission form before the deadline."],
  ["what does my readme need?", "SOURCE: Pixl Docs\nANSWER: Explain what you built, how to run it, and include a screenshot."],
  ["does my repo need to be public?", "SOURCE: Pixl Docs\nANSWER: Yes, repos must be public."],
  ["what happens if it gets returned?", "SOURCE: Pixl Docs\nANSWER: Read the reviewer feedback, make the changes, and resubmit before the deadline."],
  ["how much ai can i use?", "SOURCE: Pixl Docs\nANSWER: At most 30 percent, disclosed in your README."],
  ["what are the hardware requirements?", "SOURCE: Hardwire Docs\nANSWER: A microcontroller, a breadboard, and a soldering iron."],
  ["what about software?", "SOURCE: Hardwire Docs\nANSWER: C or MicroPython, any editor, keep source in git."],
]);

let modelCalls = 0;
let answerCalls = 0;
let realComplete;
let realCompleteStream;
before(async () => {
  programs.saveProgram(HW);
  programs.saveProgram(PIXL);
  programs.saveProgram(OTHER);
  programs.invalidate();
  for (const src of [...HW.sources, ...PIXL.sources, ...OTHER.sources]) {
    await knowledge.refreshSource(src, true);
  }
  knowledge.invalidate();

  realComplete = llm.complete;
  realCompleteStream = llm.completeStream;
  const scriptedText = (req) => {
    const question = String(req.messages.at(-1)?.content || "").trim().toLowerCase();
    return SCRIPTED.get(question) || "SOURCE: NONE\nANSWER: UNCLEAR";
  };
  llm.complete = async (req, scope) => {
    modelCalls += 1;
    if (scope === "answer") answerCalls += 1;
    return { text: scriptedText(req), finishReason: "stop" };
  };
  llm.completeStream = async (req, onDelta, scope) => {
    modelCalls += 1;
    if (scope === "answer") answerCalls += 1;
    const text = scriptedText(req);
    if (onDelta) {
      const half = Math.ceil(text.length / 2);
      onDelta(text.slice(0, half), text.slice(0, half));
      onDelta(text.slice(half), text);
    }
    return { text, stopped: false };
  };
});
after(() => {
  llm.complete = realComplete;
  llm.completeStream = realCompleteStream;
});

function fakeClient(posts) {
  return {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `post-${posts.length}` };
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: { add: async () => {}, remove: async () => {} },
    conversations: {
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
    },
  };
}

let seq = 0;
function ids() {
  seq += 1;
  return { threadTs: `ctx-t-${seq}`, userId: `ctx-u-${seq}` };
}

async function ask({ channel, question, threadContext = null, mode = respond.ALWAYS, intentVerdict = null }) {
  const posts = [];
  const updates = [];
  const { threadTs, userId } = ids();
  if (threadContext) {
    for (const [role, text] of threadContext) context_add(threadTs, role, text, userId, channel);
  }
  const before = modelCalls;
  const beforeAnswer = answerCalls;
  let intentRestore = null;
  if (intentVerdict !== null) {
    const real = intent.classifyIntentContext;
    intent.classifyIntentContext = async () => intentVerdict;
    intentRestore = () => {
      intent.classifyIntentContext = real;
    };
  }
  const client = fakeClient(posts);
  const origUpdate = client.chat.update;
  client.chat.update = async (payload) => {
    updates.push(payload);
    return origUpdate(payload);
  };
  try {
    const handled = await respond.respond({
      client,
      channel,
      threadTs,
      userId,
      question,
      mode,
      addressed: mode === respond.ALWAYS,
    });
    return { handled, posts, updates, modelCalls: modelCalls - before, answerCalls: answerCalls - beforeAnswer };
  } finally {
    if (intentRestore) intentRestore();
  }
}

function context_add(threadTs, role, text, userId, channel) {
  require("./context").addToThread(threadTs, role, text, userId, channel);
}

// Streaming posts "_thinking..._" first and edits it in place; fast answers
// post once with no edits. Either way the last text the room sees is the
// final update when edits exist, else the final post.
function visiblePosts(posts, updates) {
  if (updates.length > 0) return updates.at(-1).text || "";
  return posts.at(-1)?.text || "";
}

/* -------------------------------- retrieval + corpus scoping -- */

test("tier questions retrieve Hardwire tier evidence, scoped to Hardwire", () => {
  for (const q of ["what are tiers, explain them", "what do you do in each tier?", "what about tier 2?"]) {
    const query = lookup.retrievalQuery(q, "", programs.get("ctx-hw"));
    const ctx = knowledge.getContext(query, "ctx-hw");
    assert.match(ctx, /Tier 2 is the main build/, `no tier evidence for: ${q}`);
    assert.doesNotMatch(ctx, /purple platypus/, `cross-program leak for: ${q}`);
    assert.doesNotMatch(ctx, /submission form/, `cross-program leak for: ${q}`);
  }
});

test("pixl questions retrieve Pixl evidence, scoped to Pixl", () => {
  const cases = [
    ["how do i submit?", /submission form/],
    ["what does my readme need?", /Repos must be public/],
    ["does my repo need to be public?", /Repos must be public/],
    ["what happens if it gets returned?", /read the reviewer feedback/i],
    ["how much ai can i use?", /30 percent/],
  ];
  for (const [q, re] of cases) {
    const query = lookup.retrievalQuery(q, "", programs.get("ctx-pixl"));
    const ctx = knowledge.getContext(query, "ctx-pixl");
    assert.match(ctx, re, `no Pixl evidence for: ${q}`);
    assert.doesNotMatch(ctx, /purple platypus/, `cross-program leak for: ${q}`);
    assert.doesNotMatch(ctx, /Tier 2 is the main build/, `cross-program leak for: ${q}`);
  }
});

test("unrelated channels never see program evidence", () => {
  const ctx = knowledge.getContext("what are tiers, explain them", "ysws-global");
  assert.doesNotMatch(ctx, /Tier 2 is the main build/);
});

test("follow-up inherits conversational subject for retrieval", () => {
  const thread = "User: what are the hardware requirements?\nAssistant: A microcontroller, a breadboard, and a soldering iron.";
  const query = lookup.retrievalQuery("what about software?", thread, programs.get("ctx-hw"));
  const ctx = knowledge.getContext(query, "ctx-hw");
  assert.match(ctx, /MicroPython/, "software follow-up lost its subject");
});

/* -------------------------------------------------- end-to-end -- */

test("Hardwire tier questions are answered from Hardwire docs", async () => {
  for (const q of ["what are tiers, explain them", "what do you do in each tier?", "how do i start?", "what rewards do i get?"]) {
    const { handled, posts, updates } = await ask({ channel: "C-HW", question: q });
    assert.equal(handled, true, `not handled: ${q}`);
    assert.equal(posts.length, 1, `expected one post for: ${q}`);
    assert.match(visiblePosts(posts, updates), /Tier|tier/, `answer missing for: ${q}`);
    assert.doesNotMatch(visiblePosts(posts, updates), /purple platypus|submission form/, `cross-program leak for: ${q}`);
  }
});

test("Pixl submission questions are answered from Pixl docs", async () => {
  for (const q of ["how do i submit?", "what does my readme need?", "does my repo need to be public?", "what happens if it gets returned?", "how much ai can i use?"]) {
    const { handled, posts, updates } = await ask({ channel: "C-PIXL", question: q });
    assert.equal(handled, true, `not handled: ${q}`);
    assert.equal(posts.length, 1, `expected one post for: ${q}`);
    assert.doesNotMatch(visiblePosts(posts, updates), /purple platypus|Tier 2 is the main build/, `cross-program leak for: ${q}`);
  }
});

test("hardware then software follow-up keeps its subject", async () => {
  const posts = [];
  const updates = [];
  const { threadTs, userId } = ids();
  const client = fakeClient(posts);
  client.chat.update = async (payload) => {
    updates.push(payload);
    return {};
  };
  context_add(threadTs, "user", "what are the hardware requirements?", userId, "C-HW");
  context_add(threadTs, "assistant", "A microcontroller, a breadboard, and a soldering iron.", null, "C-HW");
  const handled = await respond.respond({
    client,
    channel: "C-HW",
    threadTs,
    userId,
    question: "what about software?",
    mode: respond.ALWAYS,
    addressed: true,
  });
  assert.equal(handled, true);
  assert.match(visiblePosts(posts, updates), /MicroPython/, "follow-up lost software subject");
});

/* -------------------------------------------------- negatives -- */

test("casual chatter with a keyword never answers, calls no model, opens nothing", async () => {
  const { handled, posts, modelCalls: calls } = await ask({
    channel: "C-HW",
    question: "tiers are cool lol",
    mode: respond.HELP_ONLY,
    intentVerdict: { verdict: intent.CASUAL_CHAT, shouldAttemptAnswer: false },
  });
  assert.equal(handled, false);
  assert.deepEqual(posts, []);
  assert.equal(calls, 0);
});

test("unsupported questions abstain visibly without inventing facts", async () => {
  const { handled, posts, updates } = await ask({ channel: "C-HW", question: "how do I file my taxes?" });
  assert.equal(handled, true);
  assert.match(visiblePosts(posts, updates), /not totally sure/, "expected the addressed fallback");
  assert.doesNotMatch(visiblePosts(posts, updates), /Tier|tier/, "invented tier content for taxes");
});

test("another program's documented fact is never answered here", async () => {
  const { handled, posts, updates } = await ask({ channel: "C-HW", question: "what is the Other mascot?" });
  assert.equal(handled, true);
  assert.doesNotMatch(visiblePosts(posts, updates), /platypus/, "cross-program fact leaked");
});

test("intent decides support-need only; grounding decides the answer", async () => {
  const yes = await ask({
    channel: "C-HW",
    question: "what are tiers, explain them",
    mode: respond.HELP_ONLY,
    intentVerdict: { verdict: intent.HELP_NEEDED, shouldAttemptAnswer: true },
  });
  assert.equal(yes.handled, true, "accepted support intent must proceed");

  const no = await ask({
    channel: "C-HW",
    question: "what are tiers, explain them",
    mode: respond.HELP_ONLY,
    intentVerdict: null,
  });
  assert.equal(no.handled, false, "failed classifier must fail closed");
  assert.equal(no.answerCalls, 0, "failed classifier must not spend an answer-generation call");
  assert.deepEqual(no.posts, []);
});
