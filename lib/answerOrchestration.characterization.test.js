process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const answer = require("./answer");
const cache = require("./cache");
const context = require("./context");
const db = require("./db");
const eligibility = require("./eligibility");
const intent = require("./intent");
const lookup = require("./lookup");
const programs = require("./programs");
const reply = require("./reply");
const respond = require("./respond");
const slackMessages = require("./slackMessages");
const tickets = require("./tickets");

db.open(":memory:");

const original = new Map();
const touched = new Set();
const objectIds = new WeakMap();
let nextObjectId = 1;

function keyFor(object, name) {
  if (!objectIds.has(object)) objectIds.set(object, nextObjectId++);
  return `${objectIds.get(object)}:${name}`;
}

function stub(object, name, replacement) {
  const key = keyFor(object, name);
  if (!original.has(key)) {
    original.set(key, { object, name, value: object[name] });
  }
  object[name] = replacement;
  touched.add(key);
}

function restore() {
  for (const key of touched) {
    const entry = original.get(key);
    entry.object[entry.name] = entry.value;
  }
  touched.clear();
  original.clear();
}

function client() {
  const calls = { posts: [], updates: [], deletes: [], reactions: [] };
  return {
    calls,
    chat: {
      postMessage: async (payload) => {
        calls.posts.push(payload.text);
        return { ts: `ts-${calls.posts.length}` };
      },
      update: async (payload) => {
        calls.updates.push(payload.text);
        return {};
      },
      delete: async (payload) => {
        calls.deletes.push(payload.ts);
        return {};
      },
    },
    reactions: { add: async (payload) => calls.reactions.push(payload) },
  };
}

function harness({ result = { source: "Pixl Docs", answer: "use the documented exporter" }, help = false, shadow = false } = {}) {
  const events = [];
  const slack = client();
  const program = { id: "characterization", name: "Characterization", helpChannel: help ? "C-help" : null, shadowMode: shadow };

  stub(programs, "forChannel", () => program);
  stub(programs, "isHelpChannel", (channel) => help && channel === "C-help");
  stub(programs, "isShadow", (candidate) => Boolean(candidate?.shadowMode));
  stub(programs, "aiAnswersEnabled", () => true);
  stub(reply, "seedFeedbackReactions", async () => {});
  stub(reply, "flagForHumans", async (...args) => events.push(["flag", ...args]));
  stub(reply, "discardPlaceholder", async () => events.push(["discard"]));
  stub(reply, "finalize", async (_client, _channel, _thread, _placeholder, text) => {
    events.push(["finalize", text]);
    return "final-ts";
  });
  stub(db, "recordMetric", (...args) => events.push(["metric", ...args]));
  stub(db, "recordGap", (...args) => events.push(["gap", ...args]));
  stub(context, "getThreadContext", () => "");
  stub(context, "addToThread", () => {});
  stub(context, "updateUserHistory", () => {});
  stub(context, "getUserContext", () => ({ recentTopics: [] }));
  stub(eligibility, "sensitiveHit", () => false);
  stub(tickets, "ensureSupportTicket", async (args) => {
    events.push(["ticket", args.threadTs]);
    return help ? { id: 42, status: "open" } : null;
  });
  stub(tickets, "markWaitingForHelper", async (...args) => events.push(["waiting", ...args]));
  stub(db, "getTicketByThreadTs", () => (help ? { id: 42, status: "open" } : null));
  stub(lookup, "answerOrChat", async (_question, _context, options) => {
    events.push(["model", options]);
    return result;
  });
  stub(lookup, "knownAnswer", lookup.knownAnswer);
  stub(intent, "classifyIntentContext", async () => ({ verdict: intent.HELP_NEEDED, shouldAttemptAnswer: true }));
  return { events, slack, program };
}

afterEach(restore);

test("context-free cache hit posts once, without model or classifier work", async () => {
  const h = harness();
  cache.put("cached question", { source: "Pixl Docs", answer: "cached answer" }, h.program.id);
  let modelCalls = 0;
  stub(lookup, "answerOrChat", async () => { modelCalls += 1; return null; });

  assert.equal(await respond.respond({ client: h.slack, channel: "C-cache", threadTs: "cache-hit", userId: "U1", question: "cached question", mode: respond.ALWAYS }), true);
  assert.equal(modelCalls, 0);
  assert.deepEqual(h.slack.calls.posts.length, 1);
  assert.ok(h.events.some(([kind, value]) => kind === "metric" && value === "answer_docs"));
});

test("contextual cache lookup bypasses the cache", async () => {
  const h = harness();
  cache.put("context question", { source: "Pixl Docs", answer: "cached answer" }, h.program.id);
  stub(context, "getThreadContext", () => "Previous conversation: the earlier answer");
  let modelCalls = 0;
  stub(lookup, "answerOrChat", async () => { modelCalls += 1; return { source: "Pixl Docs", answer: "fresh answer" }; });

  await respond.respond({ client: h.slack, channel: "C-context", threadTs: "context-hit", userId: "U2", question: "context question", mode: respond.ALWAYS });
  assert.equal(modelCalls, 1);
});

test("HELP_ONLY rejection has no ticket, model, or Slack effects", async () => {
  const h = harness();
  stub(intent, "classifyIntentContext", async () => ({ verdict: intent.CASUAL_CHAT, shouldAttemptAnswer: false }));
  let modelCalls = 0;
  stub(lookup, "answerOrChat", async () => { modelCalls += 1; return null; });

  assert.equal(await respond.respond({ client: h.slack, channel: "C-help-no", threadTs: "reject", userId: "U3", question: "just hanging out", mode: respond.HELP_ONLY }), false);
  assert.equal(modelCalls, 0);
  assert.equal(h.events.filter(([kind]) => kind === "ticket" || kind === "post").length, 0);
});

test("HELP_ONLY accepted grounded answer is answered", async () => {
  const h = harness({ help: true, result: { source: "Pixl Docs", answer: "use the documented exporter" } });
  assert.equal(await respond.respond({ client: h.slack, channel: "C-help", threadTs: "accepted", userId: "U4", question: "how do i export this", mode: respond.HELP_ONLY }), true);
  assert.ok(h.events.some(([kind]) => kind === "ticket"));
  assert.ok(h.events.some(([kind, text]) => kind === "finalize" && text.includes("documented exporter")));
});

test("ALWAYS bypasses the classifier", async () => {
  const h = harness();
  let classifierCalls = 0;
  stub(intent, "classifyIntentContext", async () => { classifierCalls += 1; return null; });
  await respond.respond({ client: h.slack, channel: "C-always", threadTs: "always", userId: "U5", question: "pixie, help me", mode: respond.ALWAYS });
  assert.equal(classifierCalls, 0);
});

test("grounded-required answers fail closed", async () => {
  const h = harness({ result: { source: null, answer: "i am not sure" } });
  const previous = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
  process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = "1";
  try {
    assert.equal(await respond.respond({ client: h.slack, channel: "C-grounded", threadTs: "grounded", userId: "U6", question: "what is the unknown rule", mode: respond.ALWAYS }), false);
    assert.ok(h.events.some(([kind]) => kind === "discard"));
    assert.equal(h.events.filter(([kind]) => kind === "finalize" || kind === "post").length, 0);
  } finally {
    if (previous === undefined) delete process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
    else process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = previous;
  }
});

test("sensitive request escalates without a model call", async () => {
  const h = harness();
  stub(eligibility, "sensitiveHit", () => true);
  let modelCalls = 0;
  stub(lookup, "answerOrChat", async () => { modelCalls += 1; return null; });
  stub(tickets, "escalateTicket", async (args) => { h.events.push(["escalate", args.threadTs]); return { id: 7 }; });

  assert.equal(await respond.respond({ client: h.slack, channel: "C-sensitive", threadTs: "sensitive", userId: "U7", question: "can i get a reimbursement exception", mode: respond.ALWAYS }), true);
  assert.equal(modelCalls, 0);
  assert.ok(h.events.some(([kind]) => kind === "escalate"));
});

test("help ticket lands before the answer and remains open", async () => {
  const h = harness({ help: true, result: { source: "Pixl Docs", answer: "grounded help" } });
  await respond.respond({ client: h.slack, channel: "C-help", threadTs: "ticket-order", userId: "U8", question: "how do i submit", mode: respond.HELP_ONLY });
  const ticketIndex = h.events.findIndex(([kind]) => kind === "ticket");
  const answerIndex = h.events.findIndex(([kind]) => kind === "finalize");
  assert.ok(ticketIndex >= 0 && ticketIndex < answerIndex);
  assert.equal(h.events.some(([kind]) => kind === "waiting"), false);
});

test("streaming answer posts a placeholder, edits it, then finalizes", async () => {
  const h = harness();
  stub(reply, "makeStreamWriter", ({ client: streamClient, channel, ensurePlaceholder }) => {
    let pending = Promise.resolve();
    return {
      write(text) {
        pending = pending.then(async () => {
          const ts = await ensurePlaceholder();
          await streamClient.chat.update({ channel, ts, text });
        });
      },
      settle() { return pending; },
    };
  });
  stub(lookup, "answerOrChat", async (_q, _c, options) => {
    options.onText("partial answer");
    return { source: "Pixl Docs", answer: "complete answer" };
  });
  await respond.respond({ client: h.slack, channel: "C-stream", threadTs: "stream", userId: "U9", question: "how does streaming work", mode: respond.ALWAYS });
  assert.deepEqual(h.slack.calls.posts.length, 1);
  assert.ok(h.slack.calls.updates.some((text) => text.includes("partial answer")));
  assert.ok(h.events.some(([kind, text]) => kind === "finalize" && text.includes("complete answer")));
});

test("model failure has one terminal fallback and error metric", async () => {
  const h = harness();
  stub(lookup, "answerOrChat", async () => { throw new Error("model down"); });
  assert.equal(await respond.respond({ client: h.slack, channel: "C-failure", threadTs: "failure", userId: "U10", question: "please help", mode: respond.ALWAYS }), true);
  assert.equal(h.events.filter(([kind]) => kind === "finalize").length, 1);
  assert.ok(h.events.some(([kind, metric, , detail]) => kind === "metric" && metric === "error" && detail === "chat_error_fallback"));
});

test("shadow mode evaluates but has no public effects", async () => {
  const h = harness({ shadow: true, result: { source: null, answer: "unconfirmed" } });
  await respond.respond({ client: h.slack, channel: "C-shadow", threadTs: "shadow", userId: "U11", question: "what is this", mode: respond.ALWAYS });
  assert.deepEqual(h.events.filter(([kind]) => kind === "finalize"), []);
  assert.ok(h.events.some(([kind]) => kind === "flag"));
  assert.ok(h.events.some(([kind, metric, , detail]) => kind === "metric" && metric === "silent" && detail === "shadow_mode"));
});

test("terminal answer records the answer metric", async () => {
  const h = harness({ result: { source: "Pixl Docs", answer: "terminal answer" } });
  await respond.respond({ client: h.slack, channel: "C-metrics", threadTs: "metrics", userId: "U12", question: "what is the answer", mode: respond.ALWAYS });
  assert.ok(h.events.some(([kind, metric]) => kind === "metric" && metric === "answer_docs"));
});
