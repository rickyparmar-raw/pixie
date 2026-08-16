process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const answer = require("./answer");
const llm = require("./llm");
const respond = require("./respond");
const cache = require("./cache");
const intent = require("./intent");
const link = require("./link");
const { config } = require("./config");

db.open(":memory:");

// respond() drives the model. Without this it makes a real call to the model API
// per assertion, which made the test slow, network-dependent, and non-hermetic —
// it timed out at node:test's 5s default whenever the API was having a slow
// minute, and a timed-out test also swallows the *next* file's tests under Bun's
// node:test shim ("test() inside another test() is not yet implemented").
// Returning null is the "docs didn't cover it" answer, which is the branch every
// assertion below is about.
answer.getGroundedAnswer = async () => null;
answer.getAnswerOrChat = async () => null;
// respond() also runs guide detection first, which falls back to a model call
// when its keyword pass misses. NONE keeps these tests on the answer path.
//
// llm is a shared, cached module — every test file `require("./llm")`s the
// same exports object. Stubbing at require time (module top level) poisons it
// during Bun's collection phase, before any file's tests have run at all, so
// before()/after() bracket the stub around this file's own execution window
// instead — anything outside that window sees the real llm.complete.
let realComplete;
before(() => {
  realComplete = llm.complete;
  llm.complete = async () => ({ text: "NONE", finishReason: "stop" });
});
after(() => {
  llm.complete = realComplete;
});

/* -------------------------------------------------- isClarifyingQuestion -- */
// Suppresses the reply that started this: an unaddressed message getting
// "sorry, what about ridit? could you clarify what you mean?" back.

test("isClarifyingQuestion catches a short question handed back to the user", () => {
  assert.equal(respond.isClarifyingQuestion("sorry, what about ridit? could you clarify what you mean?"), true);
  assert.equal(respond.isClarifyingQuestion("hmm what do you mean?"), true);
});

test("isClarifyingQuestion ignores replies that are not questions", () => {
  assert.equal(respond.isClarifyingQuestion("yeah just export it as a PNG at native size"), false);
  assert.equal(respond.isClarifyingQuestion(""), false);
  assert.equal(respond.isClarifyingQuestion(undefined), false);
});

// A real answer may still end in a question. Only the short ones — the ones
// that are nothing but the question — count as handing the work back.
test("isClarifyingQuestion ignores a real answer that ends in a question", () => {
  assert.equal(
    respond.isClarifyingQuestion(
      "check your canvas size is small, 32x32 or 16x16, and that you're exporting as PNG at native size" +
        " without scaling it up. the file extension matters too, so make sure that's right. does that sort it?",
    ),
    false,
  );
});

test("gap recording is gated on looksLikeHelpRequest", async () => {
  let escalateAdded = false;
  const mockClient = {
    chat: {
      postMessage: async () => ({ ts: "msg-1" }),
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: {
      add: async () => {
        escalateAdded = true;
      },
    },
  };

  const initialGaps = db.topGaps(100).length;

  // "thanks guys" is small talk -> should NOT record gap
  await respond.respond({
    client: mockClient,
    channel: "C-help",
    threadTs: "t-1",
    userId: "U1",
    question: "thanks guys",
    mode: respond.DOCS_ONLY,
  });

  assert.equal(db.topGaps(100).length, initialGaps);
  assert.equal(escalateAdded, false);

  // Help request miss in DOCS_ONLY -> SHOULD record gap
  await respond.respond({
    client: mockClient,
    channel: "C-help",
    threadTs: "t-2",
    userId: "U2",
    question: "my sprite wont load at all, what should i do?",
    mode: respond.DOCS_ONLY,
  });

  const afterGaps = db.topGaps(100);
  assert.equal(afterGaps.length, initialGaps + 1);
  assert.ok(afterGaps.some((g) => g.question === "my sprite wont load at all, what should i do?"));
});

test("respond refuses blocked local URLs with a friendly explanation", async () => {
  let postedText = "";
  const mockClient = {
    chat: {
      postMessage: async ({ text }) => {
        postedText = text;
        return { ts: "msg-blocked" };
      },
    },
  };

  const handled = await respond.respond({
    client: mockClient,
    channel: "C1",
    threadTs: "t-blocked",
    userId: "U1",
    question: "pixie how does this website look to u? http://localhost:8000",
    mode: respond.ALWAYS,
  });

  assert.equal(handled, true);
  assert.match(postedText, /localhost on your machine isn't reachable from the bot/);
});

/* ------------------------------------------------------ streaming + cache -- */

function fakeClient() {
  const calls = { posts: [], updates: [], deletes: 0 };
  return {
    calls,
    chat: {
      postMessage: async ({ text }) => {
        calls.posts.push(text);
        return { ts: `msg-${calls.posts.length}` };
      },
      update: async ({ text }) => {
        calls.updates.push(text);
        return {};
      },
      delete: async () => {
        calls.deletes += 1;
        return {};
      },
    },
    reactions: { add: async () => ({}) },
  };
}

// Drives respond() with a stubbed streaming answer, restoring the stub after.
async function withStreamedAnswer(chunks, fn) {
  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async (_q, _corpus, _ctx, { onText } = {}) => {
    let seen = "";
    for (const chunk of chunks) {
      seen += chunk;
      if (onText) onText(seen);
    }
    return { source: "Pixl FAQ", answer: seen };
  };
  try {
    return await fn();
  } finally {
    answer.getAnswerOrChatStream = original;
  }
}

test("respond streams the answer into the placeholder instead of waiting for all of it", async () => {
  const client = fakeClient();

  await withStreamedAnswer(["the deadline", " the deadline is august 18"], () =>
    respond.respond({
      client,
      channel: "C1",
      threadTs: "t-stream",
      userId: "U-stream",
      question: "when is the deadline",
      mode: respond.ALWAYS,
    }),
  );

  // One placeholder posted, then edited in place — never a second message.
  assert.equal(client.calls.posts.length, 1);
  assert.equal(client.calls.posts[0], "_thinking..._");
  assert.ok(client.calls.updates.length >= 1, "expected at least one streamed update");
  assert.match(client.calls.updates[client.calls.updates.length - 1], /august 18/);
});

// The bug this whole path existed to fix: respond() used to add the question to
// the thread transcript *before* reading it back, so contextPrompt was never
// empty and the cache could never be written or read on any threaded path.
test("a fresh question is cacheable, and the repeat costs no model call", async () => {
  const client = fakeClient();
  const question = "how do i export a sprite";

  let modelCalls = 0;
  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "Pixl FAQ", answer: "export it as a PNG at native size" };
  };

  try {
    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-cache-a",
      userId: "U-cache",
      question,
      mode: respond.ALWAYS,
    });
    assert.equal(modelCalls, 1);
    assert.notEqual(cache.get(question), null, "the answer should have been cached");

    // Same question, different thread, different person, reworded.
    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-cache-b",
      userId: "U-other",
      question: "  sprite   EXPORT?? ",
      mode: respond.ALWAYS,
    });
    assert.equal(modelCalls, 1, "the repeat should have been served from cache");
  } finally {
    answer.getAnswerOrChatStream = original;
  }
});

/* ------------------------------------------------- help-channel awareness -- */

// respond() knows the channel it's posting to — it must tell the model
// whether that channel IS #pixl-help, so an ungrounded miss doesn't tell
// someone already reading #pixl-help to go ask in #pixl-help.
test("respond tells the model when the channel it's replying in is the help channel", async () => {
  const savedHelpChannel = config.slack.helpChannel;
  config.slack.helpChannel = "C0HELP";

  const seen = [];
  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async (_q, _corpus, _ctx, opts = {}) => {
    seen.push(opts.inHelpChannel);
    return { source: null, answer: "not sure on that one" };
  };

  try {
    await respond.respond({
      client: fakeClient(),
      channel: "C0HELP",
      threadTs: "t-help-aware",
      userId: "U-help",
      question: "is it launched yet",
      mode: respond.ALWAYS,
    });
    await respond.respond({
      client: fakeClient(),
      channel: "C0OTHER",
      threadTs: "t-help-unaware",
      userId: "U-other",
      question: "is it launched yet also",
      mode: respond.ALWAYS,
    });
  } finally {
    answer.getAnswerOrChatStream = original;
    config.slack.helpChannel = savedHelpChannel;
  }

  assert.deepEqual(seen, [true, false]);
});

// A genuine follow-up depends on what was said above, so it must NOT be served
// a cached answer shaped by someone else's conversation.
test("a follow-up in a live thread still bypasses the cache", async () => {
  const client = fakeClient();
  let modelCalls = 0;
  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "Pixl FAQ", answer: "check your canvas size" };
  };

  try {
    const ask = (question) =>
      respond.respond({ client, channel: "C1", threadTs: "t-followup", userId: "U-f", question, mode: respond.ALWAYS });

    await ask("why is my tileset blurry");
    await ask("why is my tileset blurry");
    assert.equal(modelCalls, 2, "the second message has thread context, so it is not a cache hit");
  } finally {
    answer.getAnswerOrChatStream = original;
  }
});

// The intent gate now runs alongside the answer instead of in front of it, so
// the answer can be mid-stream when the verdict lands. Nothing may have reached
// Slack: the old serial path never started the answer at all, and posting then
// deleting a placeholder is worse noise than the delay it hides.
test("a message the gate rejects never reaches Slack, even mid-stream", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  // Answer streams first, verdict lands after — the race the old code never ran.
  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("well actually, the thing about rust is");
    await new Promise((r) => setTimeout(r, 5));
    return { source: null, answer: "well actually, the thing about rust is" };
  };
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate",
      userId: "U-gate",
      question: "does anyone know if this is even worth doing",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "no placeholder should have been posted");
    assert.deepEqual(client.calls.updates, [], "no text should have been written");
    assert.equal(client.calls.deletes, 0, "nothing to delete, because nothing was posted");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("a message the gate accepts is answered normally", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("check your canvas size");
    return { source: "Pixl Docs", answer: "check your canvas size" };
  };
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate-ok",
      userId: "U-gate-ok",
      question: "my exported sprite comes out blurry, what do i do?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, true);
    assert.equal(client.calls.posts.length, 1);
    assert.match(client.calls.updates.join(" "), /canvas size/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

// classifyIntent returns null when the network call itself fails — Zen and
// 9Router rate-limited at the same moment, not a real "nobody's asking"
// verdict. Going silent there threw away answers that generated just fine.
test("a gate that errors falls back to the local heuristic instead of going silent", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("check your canvas size");
    return { source: "Pixl Docs", answer: "check your canvas size" };
  };
  intent.classifyIntent = async () => null;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate-null",
      userId: "U-gate-null",
      question: "how do i connect hackatime",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, true);
    assert.match(client.calls.updates.join(" "), /canvas size/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("a gate that errors still stays quiet when the local heuristic also says no", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("well actually, the thing about rust is");
    return { source: null, answer: "well actually, the thing about rust is" };
  };
  intent.classifyIntent = async () => null;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate-null-quiet",
      userId: "U-gate-null-quiet",
      question: "imagine if the whole thing was written in rust",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "no placeholder should have been posted");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

/* ------------------------------------------------------ the instant path -- */

// A known answer used to cost two Slack round trips — placeholder, then edit —
// because the cache was only consulted inside answerOrChat, after the
// "_thinking..._" message had already gone out. ~800ms to say something pixie
// worked out in about a millisecond.
test("a known answer is one Slack call, with no placeholder", async () => {
  const client = fakeClient();
  const original = answer.getAnswerOrChatStream;
  let modelCalls = 0;
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "Pixl FAQ", answer: "anyone can join, no team needed" };
  };

  try {
    const ask = (threadTs, question) =>
      respond.respond({ client, channel: "C1", threadTs, userId: `U-${threadTs}`, question, mode: respond.ALWAYS });

    await ask("t-instant-a", "who can join pixl");
    assert.equal(modelCalls, 1);
    const afterFirst = { posts: client.calls.posts.length, updates: client.calls.updates.length };

    await ask("t-instant-b", "who can join pixl?");
    assert.equal(modelCalls, 1, "the second ask must not reach the model");
    assert.equal(client.calls.posts.length, afterFirst.posts + 1, "exactly one new message");
    assert.equal(client.calls.updates.length, afterFirst.updates, "and no edit of it afterwards");
    assert.equal(client.calls.posts.at(-1), "anyone can join, no team needed");
  } finally {
    answer.getAnswerOrChatStream = original;
  }
});

// Being fast is not a reason to speak when nobody asked — a cached answer has
// to clear the same gate a fresh one would.
test("the instant path still respects the gate", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    cache.put("how do i export a tileset", { source: "Pixl Docs", answer: "export at native size" });

    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-instant-gate",
      userId: "U-ig",
      question: "how do i export a tileset",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, []);
  } finally {
    intent.classifyIntent = originalIntent;
  }
});

// A pasted link has to be read before pixie says anything about it. The page
// content joins the prompt after the cache probe, so answering from cache here
// would reply to the question and ignore the link entirely.
test("a message with a link never takes the instant path", async () => {
  const client = fakeClient();
  const original = answer.getAnswerOrChatStream;
  let modelCalls = 0;
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "Pixl Docs", answer: "looks fine" };
  };

  // Stubbed so the suite stays hermetic — this test is about which path
  // respond() takes, not about fetching a real page.
  const originalFetch = link.fetchUrlContent;
  link.fetchUrlContent = async () => ({ text: "a page", blocked: false });

  try {
    cache.put("how does this look", { source: "Pixl Docs", answer: "cached opinion" });
    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-link",
      userId: "U-link",
      question: "how does this look https://pixl.rsvp",
      mode: respond.ALWAYS,
    });
    assert.equal(modelCalls, 1, "the link must be read, not answered from cache");
  } finally {
    answer.getAnswerOrChatStream = original;
    link.fetchUrlContent = originalFetch;
  }
});

/* --------------------------------------------------------- guide steps -- */
// A :upvote: reaction is now an alternative to typing "yes" (see
// onReactionAdded in lib/handlers.js), so the old "(yes/no)" wording is
// misleading on its own — formatGuideText drops it. The "here's how to
// react" explanation itself lives in a Block Kit context element
// (guides.buildGuideBlocks), not in this plain-text fallback, and only shows
// on a guide's first step — repeating it in the text of every single step
// read as spam.

test("formatGuideText leaves a step with no checkNext untouched", () => {
  assert.equal(respond.formatGuideText({ message: "all done!" }), "all done!");
});

test("formatGuideText strips the old yes/no suffix and never mentions the reaction hint", () => {
  const text = respond.formatGuideText({ message: "open the shop tab", checkNext: "see it? (yes/no)" });

  assert.ok(!text.includes("(yes/no)"));
  assert.ok(text.includes("see it?"));
  assert.ok(!text.includes(":upvote:"));
});

test("formatGuideText keeps an open-ended checkNext question intact", () => {
  const text = respond.formatGuideText({
    message: "check your RE",
    checkNext: "how much RE do you have rn?",
  });

  assert.ok(text.includes("how much RE do you have rn?"));
});

test("postGuideStep records the posted message's ts so a reaction can find it later", async () => {
  const guides = require("./guides");
  guides.startGuide("submit-ysws-guidelines", "thread-post-step", "U1");

  const client = fakeClient();
  const ts = await respond.postGuideStep({
    client,
    channel: "C1",
    threadTs: "thread-post-step",
    result: { message: "step one", checkNext: "done? (yes/no)" },
  });

  assert.equal(ts, "msg-1");
  assert.equal(db.getGuideByMessageTs("msg-1").thread_ts, "thread-post-step");
});

test("postGuideStep shows the reaction hint only on a guide's first step", async () => {
  let lastBlocks = null;
  const client = { chat: { postMessage: async ({ blocks }) => { lastBlocks = blocks; return { ts: "msg-hint-1" }; } } };

  await respond.postGuideStep({
    client,
    channel: "C1",
    threadTs: "thread-hint-first",
    result: { message: "step one", checkNext: "ready? (yes/no)" },
    isFirstStep: true,
  });
  assert.ok(lastBlocks.some((b) => b.type === "context"));

  await respond.postGuideStep({
    client,
    channel: "C1",
    threadTs: "thread-hint-later",
    result: { message: "step two", checkNext: "ready? (yes/no)" },
  });
  assert.ok(!lastBlocks.some((b) => b.type === "context"));
});

test("postGuideStep does not record a message_ts for a completed or cancelled guide", async () => {
  const guides = require("./guides");
  // Guide row still exists at post time (continueGuide/advanceGuideByReaction
  // delete it as part of returning the completed/cancelled result, so this
  // simulates the row NOT having been cleared yet) — if postGuideStep skipped
  // the completed/cancelled check, this write would succeed and the
  // assertion below would catch it.
  guides.startGuide("submit-ysws-guidelines", "thread-post-done", "U1");

  const client = { chat: { postMessage: async () => ({ ts: "msg-completed-1" }) } };
  await respond.postGuideStep({
    client,
    channel: "C1",
    threadTs: "thread-post-done",
    result: { message: "all set!", completed: true },
  });

  assert.equal(db.getGuideByMessageTs("msg-completed-1"), null);
});
