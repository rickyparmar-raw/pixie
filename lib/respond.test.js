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
const lookup = require("./lookup");
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

  // The question asked of this test isn't "does this gap appear in the ranked
  // list" (which has its own asker-count floor now) — it's "did the bot
  // record the miss at all". Look directly at doc_gaps to avoid coupling the
  // recording test to ranking changes.
  const initialGaps = db.handle().query("SELECT COUNT(*) AS c FROM doc_gaps").get().c;

  // "thanks guys" is small talk -> should NOT record gap
  await respond.respond({
    client: mockClient,
    channel: "C-help",
    threadTs: "t-1",
    userId: "U1",
    question: "thanks guys",
    mode: respond.DOCS_ONLY,
  });

  assert.equal(db.handle().query("SELECT COUNT(*) AS c FROM doc_gaps").get().c, initialGaps);
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

  const after = db.handle().query("SELECT question FROM doc_gaps").all();
  assert.equal(after.length, initialGaps + 1);
  assert.ok(after.some((g) => g.question === "my sprite wont load at all, what should i do?"));
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
    // Cache reads are tenant-scoped: the same program hits, another program
    // must not borrow the answer even for identical wording.
    const progId = require("./programs").forChannel("C1").id;
    assert.notEqual(cache.get(question, progId), null, "the answer should have been cached");
    assert.equal(cache.get(question, "__other_program__"), null, "another program must miss");

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

// classifyIntent returns null when the call itself fails — every provider
// rate-limited at once, not a real "nobody's asking" verdict. That used to fall
// back to a regex over the message. There is no regex any more, and guessing is
// exactly what this change exists to stop, so a verdict pixie could not get is
// a verdict pixie does not act on.
test("a gate that errors stays quiet rather than guessing", async () => {
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

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "no placeholder should have been posted");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

// Being addressed is not a verdict the gate gets to overturn — ALWAYS never
// calls it at all, so an outage in the classifier cannot silence a DM or a
// direct ping.
test("a gate outage cannot silence someone who addressed pixie directly", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("check your canvas size");
    return { source: "Pixl Docs", answer: "check your canvas size" };
  };
  intent.classifyIntent = async () => {
    throw new Error("every provider is rate limited");
  };

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate-always",
      userId: "U-gate-always",
      question: "where does the hackatime token go",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    assert.match(client.calls.updates.join(" "), /canvas size/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

// The gate is given the person's own recent messages, not just the message it
// is judging — that is the whole point of the change. Without them "still
// nothing" is unreadable.
test("the gate is handed the asker and channel so it can read their recent messages", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  let seen = null;
  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("check the log");
    return { source: "Pixl Docs", answer: "check the log" };
  };
  intent.classifyIntent = async (_msg, _prog, opts) => {
    seen = opts;
    return intent.HELP_NEEDED;
  };

  try {
    await respond.respond({
      client,
      channel: "C-ctx",
      threadTs: "t-gate-ctx",
      userId: "U-ctx",
      question: "still nothing",
      mode: respond.HELP_ONLY,
    });
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }

  assert.equal(seen?.userId, "U-ctx");
  assert.equal(seen?.channel, "C-ctx");
});

// A program scoped to its own questions gets a third verdict. It is not a gap
// in the docs — nothing was missing, the question just wasn't pixie's to take —
// so it is counted apart from the ordinary "nobody was asking" silence.
test("an OFF_TOPIC verdict stays quiet and is not filed as a docs gap", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  const before = db.topGaps(50).length;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("flexbox has a few ways to do that");
    return { source: null, answer: "flexbox has a few ways to do that" };
  };
  intent.classifyIntent = async () => intent.OFF_TOPIC;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-offtopic",
      userId: "U-offtopic",
      question: "how do i center a div in css",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "nothing should have been posted");
    assert.equal(db.topGaps(50).length, before, "an off-topic question is not a hole in the docs");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

// The whole point of the escape hatch: scope decides what pixie volunteers,
// never what she refuses when asked.
test("addressed is passed to the gate so a direct ask escapes the scope", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  let seen = null;
  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("use flexbox");
    return { source: "Pixl Docs", answer: "use flexbox" };
  };
  intent.classifyIntent = async (_msg, _prog, opts) => {
    seen = opts;
    return intent.HELP_NEEDED;
  };

  try {
    await respond.respond({
      client,
      channel: "C-scope",
      threadTs: "t-addressed",
      userId: "U-addressed",
      question: "pixie how do i center a div",
      mode: respond.HELP_ONLY,
      addressed: true,
    });
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }

  assert.equal(seen?.addressed, true);
});

// The program record and the channel both have to reach the answer call, or the
// prompt can't say where it is. Passing the bare id was the old bug: the model
// was told it served "the pixl program", lowercase, because that is the
// database key rather than the name.
test("the answer call is handed the program record and the channel it is in", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  let seen = null;
  answer.getAnswerOrChatStream = async (_q, _c, _ctx, opts = {}) => {
    seen = opts;
    if (opts.onText) opts.onText("check the docs");
    return { source: "Pixl Docs", answer: "check the docs" };
  };
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    await respond.respond({
      client,
      channel: "C-where",
      threadTs: "t-where",
      userId: "U-where",
      question: "how do i wire up the tileset exporter",
      mode: respond.HELP_ONLY,
    });
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }

  assert.equal(seen?.channel, "C-where");
  assert.equal(typeof seen?.program, "object", "a program record, not an id string");
  assert.ok(seen?.program?.name, "with a display name the prompt can use");
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
    // Seeded under this channel's own program: the instant path is
    // tenant-scoped, so the seed must be too.
    const progId = require("./programs").forChannel("C1").id;
    cache.put("how do i export a tileset", { source: "Pixl Docs", answer: "export at native size" }, progId);

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

/* ------------------------------------------------ handing the work back -- */
// The reply that prompted this: someone posted "eh how do i do tthis ?" in a
// program channel and got back
//
//   "do what? if you're asking about something pixl-specific like submitting,
//    setting up hackatime, git, or starting a project, just tell me what part
//    you're stuck on and i can walk you through it :hii:"
//
// which is pixie saying, at length, that it has no idea what was asked. The
// guard for this already existed — it just only recognised a hand-back that was
// nothing but a short question, and this one opens with the question and then
// keeps talking, so it sailed straight through.

test("isClarifyingQuestion catches a hand-back that carries on past the question", () => {
  assert.equal(
    respond.isClarifyingQuestion(
      "do what? if you're asking about something pixl-specific like submitting, setting up hackatime," +
        " git, or starting a project, just tell me what part you're stuck on and i can walk you through it :hii:",
    ),
    true,
  );
  assert.equal(
    respond.isClarifyingQuestion("not sure what you're referring to there — drop a bit more context and i can help :hii:"),
    true,
  );
  assert.equal(
    respond.isClarifyingQuestion("hey! could you clarify what you mean, then i'll have a proper go at it"),
    true,
  );
});

// The cost of getting this wrong is a real answer deleted, so the phrases have
// to be ones that only ever appear when pixie is asking what the subject IS —
// not ones that show up in an answer that happens to ask for a detail.
test("isClarifyingQuestion leaves real answers alone", () => {
  assert.equal(
    respond.isClarifyingQuestion(
      "depends what you're trying to do — if you just want a bigger canvas, set it before you start drawing," +
        " since resizing later rescales everything",
    ),
    false,
  );
  assert.equal(
    respond.isClarifyingQuestion(
      "the export part is under File > Export, and the scale option sits right under it — leave it at 1x",
    ),
    false,
  );
});

// A hand-back is not a documentation gap. Nothing was missing from the docs;
// pixie never worked out what the subject was, so writing the message to the
// "what should we document" list just fills it with unanswerable noise.
test("an unaddressed hand-back is deleted and not recorded as a docs gap", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  const handBack =
    "do what? if you're asking about something pixl-specific like submitting, setting up hackatime," +
    " git, or starting a project, just tell me what part you're stuck on and i can walk you through it :hii:";

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText(handBack);
    return { source: null, answer: handBack };
  };
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  const gapsBefore = db.topGaps(200).length;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-handback",
      userId: "U-handback",
      question: "eh how do i do tthis ?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.equal(db.topGaps(200).length, gapsBefore, "a hand-back is not a docs gap");
    assert.ok(client.calls.deletes >= 1, "the streamed placeholder should have been deleted");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

// The regex above is the backstop for a model that writes the paragraph anyway.
// The primary path is the model saying, in one token, that the message gave it
// nothing to answer — which has to end in silence and not in the "ask a helper"
// fallback, or the noise is the same noise with different words.
test("an unclear verdict is silence, not the mention fallback", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  const gapsBefore = db.topGaps(200).length;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-unclear",
      userId: "U-unclear",
      question: "eh how do i do tthis ?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(
      client.calls.posts.filter((t) => t !== "_thinking..._"),
      [],
      "nothing should have been posted",
    );
    assert.equal(db.topGaps(200).length, gapsBefore, "an unanswerable message is not a docs gap");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

// Somebody typed pixie's name and asked. Silence there reads as broken, so the
// existing "I've got nothing" reply stands — this path is unchanged, and the
// test is here to keep it that way.
test("an unclear verdict still answers someone who addressed pixie directly", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;

  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-unclear-addressed",
      userId: "U-unclear-addressed",
      question: "pixie how do i do this",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    assert.match(client.calls.posts.concat(client.calls.updates).join(" "), /not totally sure/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
  }
});

test("typing pixie-guide or !guide returns the interactive guide menu in thread", async () => {
  const client = fakeClient();

  const replied1 = await respond.respond({
    client,
    channel: "C1",
    threadTs: "t-guide-menu-1",
    userId: "U-guide-menu-1",
    question: "pixie-guide",
    mode: respond.ALWAYS,
  });

  assert.equal(replied1, true);
  assert.match(client.calls.posts[0], /Interactive Walkthrough Guides/);

  const replied2 = await respond.respond({
    client,
    channel: "C1",
    threadTs: "t-guide-menu-2",
    userId: "U-guide-menu-2",
    question: "!guide",
    mode: respond.ALWAYS,
  });

  assert.equal(replied2, true);
  assert.match(client.calls.posts[1], /Interactive Walkthrough Guides/);
});

test("stfu pixie mutes the thread and leaves", async () => {
  const client = fakeClient();
  const threadTs = "t-stfu-test";

  db.saveGuide(threadTs, "midi-controller", 0, "U1");
  assert.ok(db.getGuide(threadTs));

  const replied = await respond.respond({
    client,
    channel: "C1",
    threadTs,
    userId: "U1",
    question: "stfu pixie",
    mode: respond.ALWAYS,
  });

  assert.equal(replied, true);
  assert.equal(db.getGuide(threadTs), null, "active guide was cancelled");
  assert.equal(db.isThreadMuted(threadTs), true, "thread is marked as muted");
  assert.match(client.calls.posts.join(" "), /leaving the thread/);
});

// The shop maths is worked out in code, and it only ever fires on a message
// that named a priced item or answered pixie's own question about a tier. The
// gate's job is deciding whether anybody is asking for help, and by the time
// one of these comes back it has already been established that they were — so
// letting the gate bin it drops a correct, cited answer for no reason.
test("a deterministic shop answer is not thrown away by the intent gate", async () => {
  const client = fakeClient();
  const originalLookup = lookup.answerOrChat;
  const originalIntent = intent.classifyIntent;

  lookup.answerOrChat = async () => ({
    source: "Pixl Shop",
    direct: true,
    answer: "PS5 Digital, 825gb +wireless controller is 11,400 px.",
  });
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-shop",
      userId: "U-shop",
      question: "how much hours needed for t4 for ps5",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, true);
    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(said, /11,400/);
  } finally {
    lookup.answerOrChat = originalLookup;
    intent.classifyIntent = originalIntent;
  }
});

test("an ordinary ungrounded answer is still thrown away by the gate", async () => {
  const client = fakeClient();
  const originalLookup = lookup.answerOrChat;
  const originalIntent = intent.classifyIntent;

  lookup.answerOrChat = async () => ({ source: null, answer: "yeah man totally" });
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-shop-2",
      userId: "U-shop",
      question: "lol",
      mode: respond.HELP_ONLY,
    });
    assert.equal(replied, false);
  } finally {
    lookup.answerOrChat = originalLookup;
    intent.classifyIntent = originalIntent;
  }
});

/* ------------------------------------------------ brand-aware text matching -- */
// Two plain-text triggers used to be hardcoded to the word "pixie": asking for
// the guide menu, and telling the bot to be quiet. On a rebranded bot both are
// typed with its own name, so the literals would simply never fire — the mute
// request in particular is the one people reach for when the bot is being
// annoying, and it silently doing nothing is the worst version of that.

function withBrand(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the guide menu answers to the bot's own name", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.equal(respond.isGuideMenuRequest("sol guides"), true);
    assert.equal(respond.isGuideMenuRequest("sol-guide"), true);
    assert.equal(respond.isGuideMenuRequest("/sol-guide"), true);
    // Unprefixed and pixie's own forms keep working either way.
    assert.equal(respond.isGuideMenuRequest("!guides"), true);
    assert.equal(respond.isGuideMenuRequest("/guide"), true);
  });
});

test("a mute request works by the bot's own name", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.equal(respond.isMuteRequest("stfu sol"), true);
    assert.equal(respond.isMuteRequest("sol shut up"), true);
    assert.equal(respond.isMuteRequest("sol stfu"), true);
    assert.equal(respond.isMuteRequest("quiet sol"), true);
    // Same shape as the original matcher: the shush word has to lead, so a
    // mid-sentence "be quiet sol please" is not a mute. Left as-is deliberately —
    // widening it here would change what pixie itself does.
    assert.equal(respond.isMuteRequest("be quiet sol please"), false);
  });
});

test("an unrelated message is still not a mute request", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.equal(respond.isMuteRequest("how do i submit my project"), false);
    assert.equal(respond.isMuteRequest("sol how do i start"), false);
    assert.equal(respond.isGuideMenuRequest("sol what guides are there"), false);
  });
});

// The default deployment must behave exactly as before.
test("with no brand set, the pixie forms still match", () => {
  withBrand({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    assert.equal(respond.isGuideMenuRequest("pixie guides"), true);
    assert.equal(respond.isGuideMenuRequest("/pixie-guide"), true);
    assert.equal(respond.isMuteRequest("stfu pixie"), true);
    assert.equal(respond.isMuteRequest("pixie stfu"), true);
  });
});

// A slug with regex metacharacters must not blow up the matcher — it's
// interpolated into a RegExp, so it has to be escaped.
test("a slug containing regex metacharacters is escaped, not executed", () => {
  withBrand({ PIXIE_BOT_NAME: "c++ bot", PIXIE_BOT_SLUG: undefined }, () => {
    assert.doesNotThrow(() => respond.isMuteRequest("stfu c++ bot"));
    assert.equal(respond.isGuideMenuRequest("nonsense"), false);
  });
});

/* --------------------------------- help channel replies even if unknown -- */

test("help channel replies with fallback even when answer is unclear or unknown", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    const replied = await respond.respond({
      client,
      channel: "C0B6STY9G5N",
      threadTs: "t-help-unclear",
      userId: "U-user-help-1",
      question: "something totally unknown that model cannot answer",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(said, /not totally sure about that one/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("help channel replies with ungrounded answer and flags humans for gaps", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("you can use wokwi simulator");
    return { source: null, answer: "you can use wokwi simulator" };
  };
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    const replied = await respond.respond({
      client,
      channel: "C0B6STY9G5N",
      threadTs: "t-help-firmware",
      userId: "U-user-help-2",
      question: "how do i test my firmware if i don't have hardware yet",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(said, /wokwi simulator/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("help channel replies even when gate returns OFF_TOPIC in thread", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("here is some advice");
    return { source: null, answer: "here is some advice" };
  };
  intent.classifyIntent = async () => intent.OFF_TOPIC;

  try {
    const replied = await respond.respond({
      client,
      channel: "C0B6STY9G5N",
      threadTs: "t-help-offtopic",
      userId: "U-user-help-3",
      question: "how do i test my custom python script",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, true);
    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(said, /here is some advice/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("stays quiet when answer is ungrounded and PIXIE_REQUIRE_GROUNDED_ANSWER is set", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  const origEnv = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;

  answer.getAnswerOrChatStream = async () => ({
    source: null,
    answer: "i am not sure about grant amounts",
  });
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = "1";

  try {
    const replied = await respond.respond({
      client,
      channel: "C0B6STY9G5N",
      threadTs: "t-help-ungrounded",
      userId: "U-user-help-4",
      question: "how much grant for laptop",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, false);
    assert.equal(client.calls.posts.length, 0);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
    if (origEnv === undefined) delete process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
    else process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = origEnv;
  }
});

test("isGroundedAnswer correctly identifies grounded vs ungrounded answers", () => {
  const { isGroundedAnswer } = respond;
  assert.equal(isGroundedAnswer(null), false);
  assert.equal(isGroundedAnswer({ source: "NONE", answer: "UNCLEAR" }), false);
  assert.equal(isGroundedAnswer({ source: "Questions the bot should NOT invent answers for", answer: "there is no confirmed answer" }), false);
  assert.equal(isGroundedAnswer({ source: "Bot behavior rule", answer: "ask in #live-ysws" }), false);
  assert.equal(isGroundedAnswer({ source: "Live YSWS FAQ", answer: "i'm not sure about that item" }), false);
  assert.equal(isGroundedAnswer({ source: "Live Shop", answer: "you should check the shop listings" }), false);
  assert.equal(isGroundedAnswer({ source: "Live FAQ", answer: "suggest asking in <#C0BU006CTS6|live-ysws>" }), false);
  assert.equal(isGroundedAnswer({ source: "Live FAQ", answer: "Every hour of work submitted adds 20 minutes to the livestream timer." }), true);
  assert.equal(isGroundedAnswer({ source: "Live FAQ", answer: "Projects started or recorded before Live began are allowed." }), true);
});

test("stripChannelMentions removes Slack channel tags and links", () => {
  const { stripChannelMentions } = respond;
  assert.equal(stripChannelMentions("ask in <#C0BK4F6STFZ|pixie>"), "ask in");
  assert.equal(stripChannelMentions("check #live-ysws for updates"), "check for updates");
  assert.equal(stripChannelMentions("regular text without channels"), "regular text without channels");
});

test("stays quiet when source is meta or answer redirects to a channel with PIXIE_REQUIRE_GROUNDED_ANSWER", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  const origEnv = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;

  answer.getAnswerOrChatStream = async () => ({
    source: "Questions the bot should NOT invent answers for",
    answer: "there is no confirmed answer, ask in #live-ysws",
  });
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = "1";

  try {
    const replied = await respond.respond({
      client,
      channel: "C0BU006CTS6",
      threadTs: "t-help-ai-limit",
      userId: "U-user-ai",
      question: "What is the exact percentage limit of AI code allowed?",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, false);
    assert.equal(client.calls.posts.length, 0);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
    if (origEnv === undefined) delete process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
    else process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = origEnv;
  }
});


test("sensitive-category questions escalate without any model call", async () => {
  const programs = require("./programs");
  const db = require("./db");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "sens", name: "Sens", helpChannel: "C-SENS", channels: ["C-SENS"], sensitiveCategories: ["reimbursement"] },
  ]);
  programs.invalidate();
  const client = fakeClient();
  let modelCalls = 0;
  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "x", answer: "never" };
  };
  try {
    const handled = await respond.respond({
      client,
      channel: "C-SENS",
      threadTs: "t-sens-1",
      userId: "U-sens",
      question: "can I get a reimbursement exception for my flight",
      mode: respond.ALWAYS,
    });
    assert.equal(handled, true);
    assert.equal(modelCalls, 0);
    const ticket = db.getTicketByThreadTs("t-sens-1");
    assert.ok(ticket);
    assert.equal(ticket.program_id, "sens");
  } finally {
    answer.getAnswerOrChatStream = original;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("total model outage in a help channel still files a ticket", async () => {
  const db = require("./db");
  const savedHelp = config.slack.helpChannel;
  config.slack.helpChannel = "C0OUTAGE";
  const originalStream = answer.getAnswerOrChatStream;
  const originalSingle = answer.getAnswerOrChat;
  answer.getAnswerOrChatStream = async () => {
    throw new Error("every provider is down");
  };
  answer.getAnswerOrChat = async () => {
    throw new Error("every provider is down");
  };
  const client = fakeClient();
  try {
    const replied = await respond.respond({
      client,
      channel: "C0OUTAGE",
      threadTs: "t-outage-1",
      userId: "U-out",
      question: "my pcb never arrived",
      mode: respond.HELP_ONLY,
    });
    assert.equal(replied, false);
    const ticket = db.getTicketByThreadTs("t-outage-1");
    assert.ok(ticket, "ticket must exist despite the outage");
  } finally {
    answer.getAnswerOrChatStream = originalStream;
    answer.getAnswerOrChat = originalSingle;
    config.slack.helpChannel = savedHelp;
  }
});

test("shadow mode evaluates but sends nothing publicly", async () => {
  const db = require("./db");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "shdw", name: "Shadow", helpChannel: "C-SHDW", channels: ["C-SHDW"], shadowMode: true },
  ]);
  programs.invalidate();
  const client = fakeClient();
  const posted = [];
  client.chat.postMessage = async (p) => {
    posted.push(p);
    return { ts: "x" };
  };
  const originalStream = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "hmm not sure" });
  try {
    const handled = await respond.respond({
      client,
      channel: "C-SHDW",
      threadTs: "t-shdw-1",
      userId: "U-shdw",
      question: "when is the deadline",
      mode: respond.ALWAYS,
    });
    assert.equal(handled, true);
    assert.equal(posted.length, 0, "shadow must not post");
    const ticket = db.getTicketByThreadTs("t-shdw-1");
    assert.ok(ticket, "shadow still files the ticket silently");
    assert.equal(ticket.program_id, "shdw");
  } finally {
    answer.getAnswerOrChatStream = originalStream;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("exactly one terminal action: a conversational reply in the help channel is tracked as AI_ANSWERED, never as a second organizer notification", async () => {
  const db = require("./db");
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "you can try this suggestion" });
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    const threadTs = "t-help-no-double-terminal";
    const replied = await respond.respond({
      client,
      channel: "C0B6STY9G5N",
      threadTs,
      userId: "U-no-double",
      question: "how do I get started?",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(said, /you can try this suggestion/);
    // The ticket is the canonical record of the interaction — it exists —
    // but AI-answered means exactly that: no organizer card, no specialist
    // routing, just one message to the requester.
    const ticket = db.getTicketByThreadTs(threadTs);
    assert.ok(ticket, "an eligible support question in the help channel MUST create a ticket");
    assert.equal(ticket.status, "ai_answered");
    assert.equal(ticket.assignee_id, null, "AI-answered tickets are never auto-assigned");
    assert.equal(client.calls.posts.length + client.calls.updates.length, 1, "exactly one message — no separate organizer notification");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("rate limiting posts limit message but does not create tickets or leave stuck placeholders", async () => {
  const db = require("./db");
  const rateLimit = require("./rateLimit");
  const client = fakeClient();

  const userId = "U-rate-limit-test";
  // Exhaust rate limit
  for (let i = 0; i < 20; i++) {
    rateLimit.check(userId);
  }

  const threadTs = "t-rate-limit-thread";
  const replied = await respond.respond({
    client,
    channel: "C1",
    threadTs,
    userId,
    question: "pixie are you there?",
    mode: respond.ALWAYS,
  });

  assert.equal(replied, false);
  const ticket = db.getTicketByThreadTs(threadTs);
  assert.equal(ticket, null, "rate limiting must not open tickets");
  assert.match(client.calls.posts.join(" "), /slow down a sec/);
  assert.deepEqual(client.calls.posts.filter((t) => t === "_thinking..._"), [], "no placeholder posted");
});

test("escalation with placeholder in flight edits placeholder into the escalation ack", async () => {
  const db = require("./db");
  const originalStream = answer.getAnswerOrChatStream;
  const savedHelp = config.slack.helpChannel;
  config.slack.helpChannel = "C-ESC-ACK";

  const calls = { posts: [], updates: [], deletes: 0 };
  const client = {
    calls,
    chat: {
      postMessage: async ({ text }) => {
        calls.posts.push(text);
        return { ts: "ph-ack-1" };
      },
      update: async ({ text }) => {
        calls.updates.push(text);
        return {};
      },
      delete: async () => {
        calls.deletes++;
        return {};
      },
    },
  };

  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("something partial");
    await new Promise((r) => setTimeout(r, 10));
    throw new Error("provider error");
  };

  try {
    const threadTs = "t-esc-ack-thread";
    await respond.respond({
      client,
      channel: "C-ESC-ACK",
      threadTs,
      userId: "U-esc-ack",
      question: "broken pcb hardware",
      mode: respond.HELP_ONLY,
    });

    const ticket = db.getTicketByThreadTs(threadTs);
    assert.ok(ticket, "ticket should be created");
    const ackUpdates = calls.updates.filter((t) => /flagged this for a .*helper/i.test(t));
    assert.ok(ackUpdates.length > 0, "placeholder was edited into escalation ack");
  } finally {
    answer.getAnswerOrChatStream = originalStream;
    intent.classifyIntent = originalIntent;
    config.slack.helpChannel = savedHelp;
  }
});

test("prevent public reasoning and instruction leak in respond()", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;

  answer.getAnswerOrChatStream = async () => ({
    source: null,
    answer: "<think>internal hidden reasoning</think>Safety Assessment: Safe.\n**Thinking Process:**\nHere is the real answer.",
  });

  try {
    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-reasoning-leak",
      userId: "U-reasoning",
      question: "pixie explain this",
      mode: respond.ALWAYS,
    });

    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(said, /Here is the real answer\./);
    assert.doesNotMatch(said, /internal hidden reasoning/);
    assert.doesNotMatch(said, /Safety Assessment/);
    assert.doesNotMatch(said, /Thinking Process/);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
  }
});


test("the mute acknowledgement is branded with the resolved program's support identity", async () => {
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "branded-prog", name: "Branded", supportName: "Branded Help", helpChannel: "C-BRANDED", channels: ["C-BRANDED"] },
  ]);
  programs.invalidate();

  const posted = [];
  const client = { chat: { postMessage: async (payload) => { posted.push(payload); return { ts: "b-1" }; } } };

  try {
    const handled = await respond.respond({
      client,
      channel: "C-BRANDED",
      threadTs: "t-brand-mute",
      userId: "U-brand",
      question: "stfu pixie",
      mode: respond.ALWAYS,
    });
    assert.equal(handled, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].username, "Branded Help", "the mute ack must carry this program's own support identity");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

/* ------------------------------------------------- ticket-per-question -- */
// A ticket is the canonical record of every eligible support question in
// the configured help channel — not merely a human-escalation object.

function withHelpProgram(overrides, fn) {
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  const id = overrides.id || "ticket-prog";
  // guides: [] — the default fixture would otherwise inherit
  // "submit-ysws-guidelines", whose keyword detection ("submit") can hijack
  // an unrelated test question into the interactive guide flow instead of
  // the normal answer path.
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([{ id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`], guides: [], ...overrides }]);
  programs.invalidate();
  return Promise.resolve()
    .then(() => fn(id, `C-${id}`))
    .finally(() => {
      if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
      else process.env.PIXIE_PROGRAMS_JSON = saved;
      programs.invalidate();
    });
}

function richClient() {
  const posts = [];
  return {
    posts,
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `msg-${posts.length}` };
      },
      update: async (payload) => {
        posts.push({ ...payload, isUpdate: true });
        return {};
      },
    },
    reactions: { add: async () => ({}) },
  };
}

test("a grounded answer in the help channel creates a ticket marked AI_ANSWERED, with a public Resolve button the requester can use — never automatically RESOLVED", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "grounded" }, async (programId, channel) => {
    const client = richClient();
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "export as PNG at native size" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-grounded-1",
        userId: "U-grounded",
        question: "how do I export my sprite?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true);

      const ticket = db.getTicketByThreadTs("t-grounded-1");
      assert.ok(ticket);
      assert.equal(ticket.status, "ai_answered");
      assert.equal(ticket.assignee_id, null);

      const posted = client.posts[0];
      const footerBlock = posted.blocks.find((b) => b.type === "context");
      assert.match(footerBlock.elements[0].text, /Answered by Pixie/);
      const resolveBtn = posted.blocks.find((b) => b.type === "actions")?.elements.find((e) => e.action_id === "public_resolve_ticket");
      assert.ok(resolveBtn, "AI-answered footer must still carry the public Resolve button");

      // AI answering never equals RESOLVED — only an explicit Resolve does.
      assert.notEqual(ticket.status, "resolved");
      const tickets = require("./tickets");
      const resolved = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-grounded", client });
      assert.equal(resolved.ok, true);
      assert.equal(db.getTicket(ticket.id).status, "resolved");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("an AI-answered ticket produces no organizer card and no specialist assignment, even when autoAssign is on", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "noorg", autoAssign: true, organizerChannel: "C-noorg-org" }, async (programId, channel) => {
    const client = richClient();
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "the answer is 42" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({ client, channel, threadTs: "t-noorg-1", userId: "U-noorg", question: "what's the deadline?", mode: respond.HELP_ONLY });
      const ticket = db.getTicketByThreadTs("t-noorg-1");
      assert.equal(ticket.status, "ai_answered");
      assert.equal(ticket.assignee_id, null, "specialist routing must never run for an AI-answered ticket");
      assert.equal(client.posts.length, 1, "no organizer-channel card — exactly the one reply to the requester");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("escalation reuses the SAME ticket created for the question — never a second one — and specialist routing runs only there", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "escreuse", autoAssign: true, organizerChannel: "C-escreuse-org" }, async (programId, channel) => {
    const client = richClient();
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    require("./db").syncHelper({ programId, userId: "U-SPECIALIST", source: "manual" });
    try {
      const handled = await respond.respond({ client, channel, threadTs: "t-escreuse-1", userId: "U-escreuse", question: "my board never powers on", mode: respond.HELP_ONLY });
      assert.equal(handled, true);

      const allTickets = db.handle().query("SELECT * FROM tickets WHERE channel = ?").all(channel);
      assert.equal(allTickets.length, 1, "exactly one ticket for this thread, not two");
      assert.equal(allTickets[0].assignee_id, "U-SPECIALIST", "specialist routing runs once escalation actually happens");
      assert.equal(allTickets[0].status, "assigned", "auto-assign advances waiting_for_helper straight to assigned");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("pure chatter in the help channel (no @mention) does not create a ticket, even though it's a top-level message", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "chatter" }, async (programId, channel) => {
    const client = richClient();
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: null, answer: "haha yeah" });
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const handled = await respond.respond({ client, channel, threadTs: "t-chatter-1", userId: "U-chatter", question: "sam are you coming to the call?", mode: respond.ALWAYS });
      assert.equal(handled, true); // pixie still replies — ALWAYS mode
      assert.equal(db.getTicketByThreadTs("t-chatter-1"), null, "chatter must never open a ticket");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("an off-topic question in a program scoped to itself stays silent and creates no ticket", async () => {
  const db = require("./db");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([{ id: "scoped", name: "Scoped", scope: "program", channels: ["C-scoped"] }]);
  programs.invalidate();
  const client = richClient();
  const originalIntent = intent.classifyIntent;
  const originalAnswer = answer.getAnswerOrChatStream;
  intent.classifyIntent = async () => intent.OFF_TOPIC;
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "" });
  try {
    const handled = await respond.respond({ client, channel: "C-scoped", threadTs: "t-offtopic-1", userId: "U-offtopic", question: "what's the capital of France", mode: respond.HELP_ONLY });
    assert.equal(handled, false);
    assert.equal(db.getTicketByThreadTs("t-offtopic-1"), null);
  } finally {
    intent.classifyIntent = originalIntent;
    answer.getAnswerOrChatStream = originalAnswer;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("two tenants asking the identical question in their own help channels get separate, tenant-scoped tickets", async () => {
  const db = require("./db");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "tenant-a", name: "TenantA", helpChannel: "C-tenant-a", channels: ["C-tenant-a"] },
    { id: "tenant-b", name: "TenantB", helpChannel: "C-tenant-b", channels: ["C-tenant-b"] },
  ]);
  programs.invalidate();
  const client = richClient();
  const original = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "same answer for everyone" });
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    await respond.respond({ client, channel: "C-tenant-a", threadTs: "t-tenant-a-1", userId: "U-a", question: "how do reimbursements work?", mode: respond.HELP_ONLY });
    await respond.respond({ client, channel: "C-tenant-b", threadTs: "t-tenant-b-1", userId: "U-b", question: "how do reimbursements work?", mode: respond.HELP_ONLY });

    const ticketA = db.getTicketByThreadTs("t-tenant-a-1");
    const ticketB = db.getTicketByThreadTs("t-tenant-b-1");
    assert.ok(ticketA);
    assert.ok(ticketB);
    assert.notEqual(ticketA.id, ticketB.id);
    assert.equal(ticketA.program_id, "tenant-a");
    assert.equal(ticketB.program_id, "tenant-b");
  } finally {
    answer.getAnswerOrChatStream = original;
    intent.classifyIntent = originalIntent;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("public_tickets_enabled=false: Pixie still answers, but no ticket is created", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "notix", publicTicketsEnabled: false }, async (programId, channel) => {
    const client = richClient();
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "still answering" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({ client, channel, threadTs: "t-notix-1", userId: "U-notix", question: "how do I get started", mode: respond.HELP_ONLY });
      assert.equal(handled, true);
      assert.equal(client.posts.length, 1, "pixie still replies");
      assert.equal(db.getTicketByThreadTs("t-notix-1"), null, "no ticket when public tickets are off");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("public_tickets_enabled=true (default): a same-thread follow-up reuses the existing ticket rather than opening a second one", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "dedupe" }, async (programId, channel) => {
    const client = richClient();
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "first answer" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({ client, channel, threadTs: "t-dedupe-1", userId: "U-dedupe", question: "my board won't boot up at all", mode: respond.HELP_ONLY });
      const first = db.getTicketByThreadTs("t-dedupe-1");
      assert.ok(first);

      answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "a follow-up clarifying answer" });
      await respond.respond({ client, channel, threadTs: "t-dedupe-1", userId: "U-dedupe", question: "what if I'm on a team?", mode: respond.HELP_ONLY });

      const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-dedupe-1");
      assert.equal(rows.length, 1, "the same thread must never produce a second ticket");
      assert.equal(rows[0].id, first.id);
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

/* --------------------------------- ANSWER PIPELINE characterization (audit) -- */
// Pinned before the respond.js gate/decide/compose/post split. Every test
// below asserts behavior the rewrite must preserve verbatim.

test("CHAR: HELP_ONLY holds streamed output until HELP_NEEDED, drops on CASUAL_CHAT", async () => {
  await withHelpProgram({ id: "chargate" }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    try {
      // HELP_NEEDED verdict -> held output is published, reply happens.
      answer.getAnswerOrChatStream = async (_q, _c, _x, { onText } = {}) => {
        if (onText) onText("held answer text");
        return { source: "Docs", answer: "held answer text" };
      };
      intent.classifyIntent = async () => intent.HELP_NEEDED;
      const clientOk = richClient();
      const handledOk = await respond.respond({ client: clientOk, channel, threadTs: "t-char-hold-1", userId: "U-char-hold", question: "how do i submit my project", mode: respond.HELP_ONLY });
      assert.equal(handledOk, true);
      assert.ok(clientOk.posts.length >= 1);

      // CASUAL_CHAT verdict -> stream dropped, silent, no ticket.
      answer.getAnswerOrChatStream = async (_q, _c, _x, { onText } = {}) => {
        if (onText) onText("should never surface");
        return { source: null, answer: "should never surface" };
      };
      intent.classifyIntent = async () => intent.CASUAL_CHAT;
      const clientDrop = richClient();
      const handledDrop = await respond.respond({ client: clientDrop, channel, threadTs: "t-char-drop-1", userId: "U-char-drop", question: "lol that game was wild", mode: respond.HELP_ONLY });
      assert.equal(handledDrop, false);
      assert.equal(db.getTicketByThreadTs("t-char-drop-1"), null);
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: HELP_ONLY null verdict (classifier failed) stays silent", async () => {
  await withHelpProgram({ id: "charnull" }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "a docs answer" });
    intent.classifyIntent = async () => null;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-null-1", userId: "U-char-null", question: "how do i submit", mode: respond.HELP_ONLY });
      assert.equal(handled, false, "null verdict is fail-soft silent, never a guess");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: OFF_TOPIC in a help channel still replies (program-scoped redirect)", async () => {
  await withHelpProgram({ id: "charoff", scope: "program" }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: null, answer: "that one belongs to another program, try their channel" });
    intent.classifyIntent = async () => intent.OFF_TOPIC;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-off-1", userId: "U-char-off", question: "what is the deadline for some other program", mode: respond.HELP_ONLY });
      assert.equal(handled, true, "OFF_TOPIC in help still replies instead of dropping");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: ALWAYS never gates the reply but ticket worthiness prefers the classifier verdict", async () => {
  await withHelpProgram({ id: "charworthy" }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    // "sam are you coming to the call?" scores like a request on the cheap
    // heuristic but is CASUAL_CHAT to the classifier: reply yes, ticket no.
    answer.getAnswerOrChatStream = async () => ({ source: null, answer: "haha yeah" });
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-worthy-1", userId: "U-char-worthy", question: "sam are you coming to the call?", mode: respond.ALWAYS });
      assert.equal(handled, true, "ALWAYS mode always replies");
      assert.equal(db.getTicketByThreadTs("t-char-worthy-1"), null, "classifier verdict beats the heuristic: no ticket for chatter");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: grounded answer in help is ticket-eligible even when the request heuristic says no", async () => {
  await withHelpProgram({ id: "charground" }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "export as PNG at native size" });
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const client = richClient();
      await respond.respond({ client, channel, threadTs: "t-char-ground-1", userId: "U-char-g1", question: "png export", mode: respond.HELP_ONLY });
      // HELP_ONLY+CASUAL drops before tickets, so drive the eligible branch
      // via ALWAYS with a grounded answer and a CASUAL ticket verdict.
      const client2 = richClient();
      await respond.respond({ client: client2, channel, threadTs: "t-char-ground-2", userId: "U-char-g2", question: "how do i export my sprite", mode: respond.ALWAYS });
      const ticket = db.getTicketByThreadTs("t-char-ground-2");
      assert.ok(ticket, "grounded answer is inherently eligible");
      assert.equal(ticket.status, "ai_answered");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: shadow program evaluates but posts nothing publicly", async () => {
  await withHelpProgram({ id: "charshadow", shadowMode: true }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "a grounded answer" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const client = richClient();
      await respond.respond({ client, channel, threadTs: "t-char-shadow-1", userId: "U-char-shadow", question: "how do i submit", mode: respond.HELP_ONLY });
      assert.equal(client.posts.length, 0, "shadow mode sends nothing publicly");
      assert.equal(db.getTicketByThreadTs("t-char-shadow-1"), null, "shadow mode files no ticket");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: sensitive match escalates with zero model calls", async () => {
  const elig = require("./eligibility");
  const tickets = require("./tickets");
  const originalSensitive = elig.sensitiveHit;
  const originalEscalate = tickets.escalateTicket;
  const originalStream = answer.getAnswerOrChatStream;
  let modelCalls = 0;
  let escalated = false;
  elig.sensitiveHit = () => true;
  tickets.escalateTicket = async () => { escalated = true; return { id: 9999 }; };
  answer.getAnswerOrChatStream = async () => { modelCalls += 1; return { source: "Docs", answer: "must not happen" }; };
  try {
    const client = richClient();
    await respond.respond({ client, channel: "C-char-sens", threadTs: "t-char-sens-1", userId: "U-char-sens", question: "anything at all", mode: respond.ALWAYS });
    assert.equal(modelCalls, 0, "defense-in-depth: no model call on sensitive");
    assert.equal(escalated, true, "sensitive files a ticket via escalateTicket");
  } finally {
    elig.sensitiveHit = originalSensitive;
    tickets.escalateTicket = originalEscalate;
    answer.getAnswerOrChatStream = originalStream;
  }
});

test("CHAR: model outage in help channel still files a ticket and stays quiet", async () => {
  await withHelpProgram({ id: "charoutage" }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalLookup = lookup.answerOrChat;
    answer.getAnswerOrChatStream = async () => { throw new Error("every provider is down"); };
    lookup.answerOrChat = async () => { throw new Error("every provider is down"); };
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-outage-1", userId: "U-char-outage", question: "how do i submit my project", mode: respond.HELP_ONLY });
      assert.equal(handled, false, "outage in help: ticket filed, no AI reply");
      assert.ok(db.getTicketByThreadTs("t-char-outage-1"), "outage must not swallow the support request");
    } finally {
      answer.getAnswerOrChatStream = original;
      lookup.answerOrChat = originalLookup;
    }
  });
});

test("CHAR: HELP_ONLY suppresses hand-back clarification questions outside help", async () => {
  const original = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  // Non-help channel: use a bare program channel fixture instead.
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([{ id: "charhand", name: "charhand", channels: ["C-charhand"], guides: [] }]);
  programs.invalidate();
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "sorry, what do you mean?" });
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    const client = richClient();
    const handled = await respond.respond({ client, channel: "C-charhand", threadTs: "t-char-hand-1", userId: "U-char-hand", question: "eh how do i do this", mode: respond.HELP_ONLY });
    assert.equal(handled, false, "hand-back clarification stays quiet when unaddressed");
  } finally {
    answer.getAnswerOrChatStream = original;
    intent.classifyIntent = originalIntent;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("CHAR: ASKS_WHAT_THEY_MEAN regex stays as backstop + MAX_CLARIFY_WORDS bound", () => {
  assert.equal(respond.isClarifyingQuestion("what do you mean?"), true);
  assert.equal(respond.isClarifyingQuestion("could you clarify what you mean"), true);
  // Long genuine answer ending in a question is not a hand-back.
  const longReal = "check your canvas size is small, 32x32 or 16x16, and that you are exporting as PNG at native size without scaling it up because the file extension matters too for the reviewer pipeline. does that sort it for your sprite workflow today?";
  assert.equal(respond.isClarifyingQuestion(longReal), false);
});

test("CHAR: answerOrChat is the single call shared by the mention path and --ask", () => {
  assert.equal(respond.answerOrChat, lookup.answerOrChat, "--ask must print what Slack would get");
});

test("CHAR: cache path enforces the gate (null verdict stays quiet)", async () => {
  await withHelpProgram({ id: "charcache" }, async (programId, channel) => {
    const originalIntent = intent.classifyIntent;
    const originalKnown = lookup.knownAnswer;
    lookup.knownAnswer = () => ({ source: "Docs", answer: "cached answer here" });
    intent.classifyIntent = async () => null;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-cache-1", userId: "U-char-cache", question: "cached question here", mode: respond.HELP_ONLY });
      assert.equal(handled, false, "fast path is not an excuse to speak when nobody asked");
    } finally {
      lookup.knownAnswer = originalKnown;
      intent.classifyIntent = originalIntent;
    }
  });
});
