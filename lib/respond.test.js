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
const context = require("./context");
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
let savedFaq;
before(() => {
  // Test channels without their own program config are claimed as main
  // (FAQ) channels: respond() ignores channels nobody claimed.
  savedFaq = config.slack.faqChannels;
  config.slack.faqChannels = [...(savedFaq || []), "C1", "C-where", "C-latest", "C-followup", "C-ctx", "C-scope", "C-scoped", "C-charhand", "C0OTHER", "C-help"];
  realComplete = llm.complete;
  llm.complete = async () => ({ text: "NONE", finishReason: "stop" });
});
after(() => {
  llm.complete = realComplete;
  config.slack.faqChannels = savedFaq;
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

test("gap recording is gated on engagement: chatter records nothing, an engaged miss records a gap", async () => {
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

  // Ambient chatter never reaches retrieval, so there is no miss to record.
  // An engaged question whose answer comes back ungrounded IS the miss.
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async (message) => (/sprite wont load/.test(message) ? intent.HELP_NEEDED : intent.CASUAL_CHAT);
  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "hmm not sure on that one" }));
  const restoreCache = stubNoCache();

  try {
    // "thanks guys" is small talk -> should NOT record gap
    await respond.respond({
      client: mockClient,
      channel: "C-help",
      threadTs: "t-1",
      userId: "U1",
      question: "thanks guys",
      mode: respond.HELP_ONLY,
    });

    assert.equal(db.handle().query("SELECT COUNT(*) AS c FROM doc_gaps").get().c, initialGaps);
    assert.equal(escalateAdded, false);

    // Engaged but ungrounded in ambient -> SHOULD record gap (and stay silent)
    const replied = await respond.respond({
      client: mockClient,
      channel: "C-help",
      threadTs: "t-2",
      userId: "U2",
      question: "my sprite wont load at all, what should i do?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    const after = db.handle().query("SELECT question FROM doc_gaps").all();
    assert.equal(after.length, initialGaps + 1);
    assert.ok(after.some((g) => g.question === "my sprite wont load at all, what should i do?"));
  } finally {
    intent.classifyIntent = originalIntent;
    restoreAnswers();
    restoreCache();
  }
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

// The pipeline only streams an addressed general request — every program-kind
// path (ambient, addressed program, help) calls the NON-streaming
// getAnswerOrChat. Stub both so a test pins the answer whichever path the
// pipeline picks, and restore both afterwards. impl receives the normalized
// streaming-style args (question, corpus, contextPrompt, opts).
function stubAnswers(impl) {
  const origPlain = answer.getAnswerOrChat;
  const origStream = answer.getAnswerOrChatStream;
  answer.getAnswerOrChat = async (q, corpus, ctx, inHelp, prog, channel, opts = {}) =>
    impl(q, corpus, ctx, { onText: null, inHelpChannel: inHelp, program: prog, channel, ...(opts || {}) });
  answer.getAnswerOrChatStream = async (q, corpus, ctx, opts = {}) => impl(q, corpus, ctx, opts);
  return () => {
    answer.getAnswerOrChat = origPlain;
    answer.getAnswerOrChatStream = origStream;
  };
}

// Pin the fast path shut for tests about ungrounded/unclear behavior: a stale
// grounded entry cached by an earlier test must not answer for the stub.
function stubNoCache() {
  const orig = lookup.knownAnswer;
  lookup.knownAnswer = () => null;
  return () => {
    lookup.knownAnswer = orig;
  };
}

// Only an addressed general request streams: program-kind answers are posted
// whole, after the grounding guards have run, so there is never a moment
// where an unverified claim is visible on screen.
test("respond streams the answer into the placeholder instead of waiting for all of it", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;
  // CASUAL_CHAT + addressed -> addressed_smalltalk -> general kind, the one
  // path that still streams.
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async (_q, _corpus, _ctx, { onText } = {}) => {
    let seen = "";
    for (const chunk of ["Cream butter", "Cream butter and sugar, add chips, bake at 180C"]) {
      seen = chunk;
      if (onText) onText(seen);
    }
    return { source: null, answer: seen };
  };

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-stream",
      userId: "U-stream",
      question: "pixie, give me a chocolate chip cookie recipe",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    // One placeholder posted, then edited in place — never a second message.
    assert.equal(client.calls.posts.length, 1);
    assert.equal(client.calls.posts[0], "_thinking..._");
    assert.ok(client.calls.updates.length >= 1, "expected at least one streamed update");
    assert.match(client.calls.updates[client.calls.updates.length - 1], /chips/);
  } finally {
    answer.getAnswerOrChatStream = original;
    intent.classifyIntent = originalIntent;
  }
});

// The bug this whole path existed to fix: respond() used to add the question to
// the thread transcript *before* reading it back, so contextPrompt was never
// empty and the cache could never be written or read on any threaded path.
test("a fresh question is cacheable, and the repeat costs no model call", async () => {
  const client = fakeClient();
  const question = "how do i export a sprite";

  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Pixl FAQ", answer: "export it as a PNG at native size" };
  });

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
    restoreAnswers();
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
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  // Program-kind answers take the non-streaming path, which receives the
  // help-channel flag as a positional arg.
  const restoreAnswers = stubAnswers(async (_q, _c, _ctx, opts = {}) => {
    seen.push(opts.inHelpChannel);
    return { source: "Pixl Docs", answer: "here is the launch status" };
  });

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
    restoreAnswers();
    intent.classifyIntent = originalIntent;
    config.slack.helpChannel = savedHelpChannel;
  }

  assert.deepEqual(seen, [true, false]);
});

// A genuine follow-up depends on what was said above, so it must NOT be served
// a cached answer shaped by someone else's conversation.
test("a follow-up in a live thread still bypasses the cache", async () => {
  const client = fakeClient();
  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Pixl FAQ", answer: "check your canvas size" };
  });

  try {
    const ask = (question) =>
      respond.respond({ client, channel: "C1", threadTs: "t-followup", userId: "U-f", question, mode: respond.ALWAYS });

    await ask("why is my tileset blurry");
    await ask("why is my tileset blurry");
    assert.equal(modelCalls, 2, "the second message has thread context, so it is not a cache hit");
  } finally {
    restoreAnswers();
  }
});

// The intent gate now runs alongside the answer instead of in front of it, so
// the answer can be mid-stream when the verdict lands. Nothing may have reached
// Slack: the old serial path never started the answer at all, and posting then
// deleting a placeholder is worse noise than the delay it hides.
test("a message the gate rejects never reaches Slack, even mid-stream", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChat;
  const originalStream = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  // Answer streams first, verdict lands after — the race the old code never ran.
  // Ambient program answers are never streamed, so even a streaming-shaped
  // answer must not reach Slack when the gate rejects the message.
  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("well actually, the thing about rust is");
    await new Promise((r) => setTimeout(r, 5));
    return { source: null, answer: "well actually, the thing about rust is" };
  };
  answer.getAnswerOrChat = async () => ({ source: null, answer: "well actually, the thing about rust is" });
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    context.addToThread("t-followup-structured", "user", "where do I submit?", "U-followup", "C-followup");
    context.addToThread("t-followup-structured", "assistant", "Submit it through the Pixl portal.", null, "C-followup");
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
    answer.getAnswerOrChat = originalAnswer;
    answer.getAnswerOrChatStream = originalStream;
    intent.classifyIntent = originalIntent;
  }
});

test("off-topic chatter in an implicit addressed thread stays silent", async () => {
  const client = fakeClient();
  const originalContextIntent = intent.classifyIntentContext;
  intent.classifyIntentContext = async () => ({ directedAtHuman: true, verdict: intent.CASUAL_CHAT });

  try {
    const handled = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-thread-chatter",
      userId: "U-thread-chatter",
      question: "which has realtime data",
      mode: respond.ALWAYS,
      addressedHow: "thread",
    });

    assert.equal(handled, false);
    assert.deepEqual(client.calls.posts, []);
    assert.deepEqual(client.calls.updates, []);
    assert.equal(client.calls.deletes, 0);
  } finally {
    intent.classifyIntentContext = originalContextIntent;
  }
});

test("a message the gate accepts is answered normally", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  // Ambient program answers post whole, with no placeholder and no streamed
  // edits — streaming would show text before the grounding guards run.
  const restoreAnswers = stubAnswers(async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("check your canvas size");
    return { source: "Pixl Docs", answer: "check your canvas size" };
  });
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
    assert.match(client.calls.posts.join(" "), /canvas size/);
    assert.deepEqual(client.calls.updates, [], "ambient answers are never streamed");
  } finally {
    restoreAnswers();
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
// direct ping. A classifier error on an addressed message is treated as a
// program question: grounded answer or transparent uncertainty.
test("a gate outage cannot silence someone who addressed pixie directly", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: "Pixl Docs", answer: "check your canvas size" }));
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
    assert.match(client.calls.posts.join(" "), /canvas size/);
  } finally {
    restoreAnswers();
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

test("respond passes the latest question into context selection", async () => {
  let seen = "";
  const restoreAnswers = stubAnswers(async (_q, _c, contextPrompt) => {
    seen = contextPrompt;
    return { source: "Pixl Docs", answer: "got it" };
  });
  context.addToThread("t-latest-question", "user", "old unrelated question", "U-latest", "C-latest");
  context.addToThread("t-latest-question", "assistant", "old answer", null, "C-latest");
  try {
    await respond.respond({
      client: fakeClient(), channel: "C-latest", threadTs: "t-latest-question",
      userId: "U-latest", question: "how do i submit this project?", mode: respond.ALWAYS,
    });
  } finally {
    restoreAnswers();
  }
  assert.match(seen, /how do i submit this project/);
});

test("HELP_ONLY consumes structured intent and preserves Pixie follow-up context", async () => {
  const client = fakeClient();
  const originalContextIntent = intent.classifyIntentContext;
  let seen = null;
  const restoreAnswers = stubAnswers(async (_q, _c, contextPrompt) => {
    seen = contextPrompt;
    return { source: "Pixl Docs", answer: "yes, it should be public" };
  });
  intent.classifyIntentContext = async (_message, _program, options) => ({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    directedAtPixie: false,
    directedAtHuman: false,
    recentPixieParticipation: true,
    programRelevance: "relevant",
    needsHelp: true,
    shouldAttemptAnswer: true,
    threadMessages: options.threadMessages,
  });

  try {
    const replied = await respond.respond({
      client,
      channel: "C-followup",
      threadTs: "t-followup-structured",
      userId: "U-followup",
      question: "does it need to be public?",
      mode: respond.HELP_ONLY,
    });
    assert.equal(replied, true);
    assert.match(seen || "", /Previous conversation/);
  } finally {
    restoreAnswers();
    intent.classifyIntentContext = originalContextIntent;
  }
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
  const originalIntent = intent.classifyIntent;

  // The non-streaming answer call takes (question, corpus, context, inHelp,
  // program, channel): the model must be told where it is, and the program
  // as a record (with a display name), never a bare id string.
  let seen = null;
  const restoreAnswers = stubAnswers(async (_q, _c, _ctx, opts = {}) => {
    seen = opts;
    return { source: "Pixl Docs", answer: "check the docs" };
  });
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
    restoreAnswers();
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
  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Pixl FAQ", answer: "anyone can join, no team needed" };
  });

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
    restoreAnswers();
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
  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Pixl Docs", answer: "looks fine" };
  });

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
    restoreAnswers();
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
  const originalIntent = intent.classifyIntent;

  const handBack =
    "do what? if you're asking about something pixl-specific like submitting, setting up hackatime," +
    " git, or starting a project, just tell me what part you're stuck on and i can walk you through it :hii:";

  // Ungrounded by construction (no source): ambient never posts it, so there
  // is no placeholder to delete — silence is the whole behavior.
  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: handBack }));
  const restoreCache = stubNoCache();
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
    assert.deepEqual(client.calls.posts, [], "an ungrounded ambient answer is never posted");
  } finally {
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
  }
});

// The regex above is the backstop for a model that writes the paragraph anyway.
// The primary path is the model saying, in one token, that the message gave it
// nothing to answer — which has to end in silence and not in the "ask a helper"
// fallback, or the noise is the same noise with different words.
test("an unclear verdict is silence, not the mention fallback", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
  const restoreCache = stubNoCache();
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
    assert.deepEqual(client.calls.posts, [], "nothing should have been posted");
    assert.equal(db.topGaps(200).length, gapsBefore, "an unanswerable message is not a docs gap");
  } finally {
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
  }
});

// Somebody typed pixie's name and asked. Silence there reads as broken, so a
// reply stands — but it is the transparent uncertainty text now, never the
// old "not totally sure" guess-shaped fallback and never an ungrounded fact.
test("an unclear verdict still answers someone who addressed pixie directly", async () => {
  const client = fakeClient();

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
  const restoreCache = stubNoCache();

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
    assert.match(client.calls.posts.concat(client.calls.updates).join(" "), /couldn't verify/);
  } finally {
    restoreAnswers();
    restoreCache();
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
test("an unaddressed deterministic answer still requires support intent", async () => {
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

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, []);
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

// Live failure: Pixie could acknowledge "got it, leaving the thread" for
// some stop phrasings but not others, so mute never actually engaged for the
// ones it missed — "stop pixie", "pixiestop" and "stop pinging him" in
// particular kept getting silently ignored.
test("every documented stop/leave phrasing is recognized, and 'stop' alone is anchored, not bare", () => {
  assert.equal(respond.isMuteRequest("stop pixie"), true);
  assert.equal(respond.isMuteRequest("pixiestop"), true);
  assert.equal(respond.isMuteRequest("stoppixie"), true);
  assert.equal(respond.isMuteRequest("stop pinging him"), true);
  assert.equal(respond.isMuteRequest("stop pinging"), true);
  assert.equal(respond.isMuteRequest("pixie leave"), true);
  assert.equal(respond.isMuteRequest("shut up pixie"), true);

  // Bare "stop" must stay anchored the same way every other shush word is —
  // message-initial with the name following, never a substring match.
  assert.equal(respond.isMuteRequest("please stop, pixie already helped"), false);
  assert.equal(respond.isMuteRequest("stop the build please"), false);
  assert.equal(respond.isMuteRequest("can we stop for today"), false);
  // "stopping" is literally "stop"+"ping" with zero separator and must never
  // be mistaken for "stop ping(ing)".
  assert.equal(respond.isMuteRequest("pixie is stopping by later"), false);
});

/* --------------------------------- help channel replies even if unknown -- */

test("help channel hands an unclear question to a helper with the escalated uncertainty text", async () => {
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  await withHelpProgram({ id: "help-unclear" }, async (programId, channel) => {
    const client = richClient();
    try {
      const replied = await respond.respond({
        client,
        channel,
        threadTs: "t-help-unclear",
        userId: "U-user-help-1",
        question: "something totally unknown that model cannot answer",
        mode: respond.ALWAYS,
      });

      assert.equal(replied, true);
      const said = client.posts.map((p) => p.text || "").join(" ");
      assert.match(said, /couldn't verify/);
      assert.match(said, /flagged it for a helper/);
      const ticket = db.getTicketByThreadTs("t-help-unclear");
      assert.ok(ticket, "the support request still lands with humans");
      assert.equal(ticket.status, "waiting_for_helper");
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("a ping in the help channel gets the answer and still goes to a helper", async () => {
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "you can use wokwi simulator" }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  await withHelpProgram({ id: "help-firmware" }, async (programId, channel) => {
    const client = richClient();
    try {
      const replied = await respond.respond({
        client,
        channel,
        threadTs: "t-help-firmware",
        userId: "U-user-help-2",
        question: "how do i test my firmware if i don't have hardware yet",
        mode: respond.ALWAYS,
      });

      assert.equal(replied, true);
      const said = client.posts.map((p) => p.text || "").join(" ");
      assert.match(said, /wokwi simulator/);
      assert.doesNotMatch(said, /couldn't verify/);
      const ticket = db.getTicketByThreadTs("t-help-firmware");
      assert.ok(ticket);
      assert.equal(ticket.status, "waiting_for_helper");
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("help channel stays quiet when gate returns OFF_TOPIC in thread", async () => {
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

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, []);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("an ungrounded answer in help hands off with uncertainty even when PIXIE_REQUIRE_GROUNDED_ANSWER is set", async () => {
  const originalIntent = intent.classifyIntent;
  const origEnv = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;

  const restoreAnswers = stubAnswers(async () => ({
    source: null,
    answer: "i am not sure about grant amounts",
  }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = "1";

  await withHelpProgram({ id: "help-grounded-req" }, async (programId, channel) => {
    const client = richClient();
    try {
      const replied = await respond.respond({
        client,
        channel,
        threadTs: "t-help-ungrounded",
        userId: "U-user-help-4",
        question: "how much grant for laptop",
        mode: respond.ALWAYS,
      });

      // Help never drops the support request: ticket + handoff, and the only
      // public text is the transparent uncertainty — never the guess.
      assert.equal(replied, true);
      const said = client.posts.map((p) => p.text || "").join(" ");
      assert.doesNotMatch(said, /grant amounts/);
      assert.match(said, /couldn't verify/);
      assert.ok(db.getTicketByThreadTs("t-help-ungrounded"));
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
      if (origEnv === undefined) delete process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
      else process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = origEnv;
    }
  });
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

test("a meta source or channel redirect stays unposted in a DM, with uncertainty instead", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;
  const origEnv = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;

  const restoreAnswers = stubAnswers(async () => ({
    source: "Questions the bot should NOT invent answers for",
    answer: "there is no confirmed answer, ask in #live-ysws",
  }));
  const restoreCache = stubNoCache();
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

    // An unclaimed channel with an addressed caller is a DM: the redirect is
    // stripped and the caller hears transparent uncertainty, never the guess.
    assert.equal(replied, true);
    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.doesNotMatch(said, /live-ysws/);
    assert.match(said, /couldn't verify/);
  } finally {
    restoreAnswers();
    restoreCache();
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

test("a classifier outage in a help channel preserves the support path (ticket + helper)", async () => {
  const db = require("./db");
  const savedHelp = config.slack.helpChannel;
  config.slack.helpChannel = "C0OUTAGE";
  const client = fakeClient();
  // No classifier stub: the suite-wide llm stub ("NONE") makes the legacy
  // classifier return null, i.e. the outage path. The ticket needs no AI, so
  // the support request still lands with humans — and with nobody addressed,
  // nothing is posted publicly.
  try {
    const replied = await respond.respond({
      client,
      channel: "C0OUTAGE",
      threadTs: "t-outage-1",
      userId: "U-out",
      question: "my pcb never arrived",
      mode: respond.HELP_ONLY,
    });
    assert.equal(replied, true);
    const ticket = db.getTicketByThreadTs("t-outage-1");
    assert.ok(ticket, "the outage must not swallow the support request");
    assert.equal(ticket.status, "waiting_for_helper");
    // The open-ticket UI posts (the thread reads: question, ticket UI), but
    // no AI answer of any kind goes out during the outage.
    assert.ok(client.calls.posts.every((t) => /Someone will be here to help you soon!/.test(t)));
  } finally {
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
  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "hmm not sure" }));
  const restoreCache = stubNoCache();
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
    restoreAnswers();
    restoreCache();
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("a support question in an active help channel opens a ticket that stays OPEN when Pixie answers it", async () => {
  const db = require("./db");
  const originalIntent = intent.classifyIntent;
  const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "here is how to get started with your project" }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  await withHelpProgram({ id: "one-terminal" }, async (programId, channel) => {
    const client = richClient();
    try {
      const threadTs = "t-help-open";
      const replied = await respond.respond({ client, channel, threadTs, userId: "U-open", question: "how do I get started?", mode: respond.ALWAYS });
      assert.equal(replied, true);

      const said = client.posts.map((p) => p.text || "").join(" ");
      assert.match(said, /here is how to get started/);
      assert.match(said, /Someone will be here to help you soon/);

      const ticket = db.getTicketByThreadTs(threadTs);
      assert.ok(ticket, "an eligible support question MUST create a ticket");
      assert.equal(ticket.status, "open", "a Pixie answer does not resolve or re-status the ticket");
      assert.equal(ticket.assignee_id, null);
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
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

test("answer generation throwing still leaves an open, usable ticket in the thread", async () => {
  const db = require("./db");
  const originalStream = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  answer.getAnswerOrChatStream = async (_q, _c, _ctx, { onText } = {}) => {
    if (onText) onText("something partial");
    await new Promise((r) => setTimeout(r, 10));
    throw new Error("provider error");
  };

  await withHelpProgram({ id: "esc-throw" }, async (programId, channel) => {
    const client = richClient();
    try {
      const threadTs = "t-esc-throw";
      await respond.respond({ client, channel, threadTs, userId: "U-esc-throw", question: "my pcb won't power on", mode: respond.ALWAYS });

      const ticket = db.getTicketByThreadTs(threadTs);
      assert.ok(ticket, "the ticket is the reliable baseline — it exists even when answer generation throws");
      assert.ok(["open", "waiting_for_helper", "assigned"].includes(ticket.status));
      assert.match(client.posts.map((p) => p.text || "").join(" "), /Someone will be here to help you soon/);
    } finally {
      answer.getAnswerOrChatStream = originalStream;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("prevent public reasoning and instruction leak in respond()", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  // A general (conversational) request is posted as written, so the
  // reasoning-strip has to have run before it reaches Slack.
  intent.classifyIntent = async () => intent.CASUAL_CHAT;
  const restoreAnswers = stubAnswers(async () => ({
    source: null,
    answer: "<think>internal hidden reasoning</think>Safety Assessment: Safe.\n**Thinking Process:**\nHere is the real answer.",
  }));
  const restoreCache = stubNoCache();

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
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
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

test("HELP_ONLY rejects intent before answer generation and ticket creation", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "intent-first" }, async (programId, channel) => {
    const client = richClient();
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    let answerCalls = 0;
    lookup.answerOrChat = async () => {
      answerCalls += 1;
      return { source: "Docs", answer: "must not be used" };
    };
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-intent-first",
        userId: "U-intent-first",
        question: "just chatting about the project",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, false);
      assert.equal(answerCalls, 0, "rejected support intent must not call answer generation");
      assert.equal(db.getTicketByThreadTs("t-intent-first"), null, "rejected support intent must not create a ticket");
      assert.deepEqual(client.posts, []);
    } finally {
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

// Section 9 fixture: "lol", "wtf", "hi" and similar must never select a
// helper. worthClassifying (lib/intent.js) already filters pure reactions
// before any model call; this locks in the case where the words survive that
// filter but the classifier still correctly reads them as chatter.
test("chatter that clears the noise filter still selects no helper and opens no ticket", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "chatter-no-select", helperPing: true }, async (programId, channel) => {
    for (const chatter of ["lol what do u think", "wtf is happening", "hii everyone"]) {
      const client = richClient();
      const originalLookup = lookup.answerOrChat;
      const originalIntent = intent.classifyIntent;
      lookup.answerOrChat = async () => ({ source: "Docs", answer: "must not be used" });
      intent.classifyIntent = async () => intent.CASUAL_CHAT;
      try {
        const handled = await respond.respond({
          client, channel, threadTs: `t-chatter-${chatter.length}`, userId: "U-chatter",
          question: chatter, mode: respond.HELP_ONLY,
        });
        assert.equal(handled, false, chatter);
        assert.equal(db.getTicketByThreadTs(`t-chatter-${chatter.length}`), null, chatter);
        assert.deepEqual(client.posts, [], chatter);
      } finally {
        lookup.answerOrChat = originalLookup;
        intent.classifyIntent = originalIntent;
      }
    }
  });
});

test("grounded HELP_ONLY support still answers when tickets are disabled", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "answers-no-tickets", ticketsEnabled: false }, async (programId, channel) => {
    const client = richClient();
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    lookup.answerOrChat = async () => ({ source: "Docs", answer: "export as PNG at native size" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-no-tickets-grounded",
        userId: "U-no-tickets",
        question: "how do I export my sprite?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true);
      assert.match(client.posts.map((p) => p.text || "").join(" "), /export as PNG/);
      assert.equal(db.getTicketByThreadTs("t-no-tickets-grounded"), null);
    } finally {
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("an accepted support question with no grounded answer waits on its ticket", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "no-grounding" }, async (programId, channel) => {
    const client = richClient();
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    lookup.answerOrChat = async () => ({ source: null, answer: "I am not sure" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-no-grounding",
        userId: "U-no-grounding",
        question: "my board will not power on, what should I check?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true);
      assert.equal(db.getTicketByThreadTs("t-no-grounding").status, "waiting_for_helper");
    } finally {
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("persisted aiAnswers=false skips answer generation without disabling tickets", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "answers-off", aiAnswers: false }, async (programId, channel) => {
    const client = richClient();
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    let answerCalls = 0;
    lookup.answerOrChat = async () => {
      answerCalls += 1;
      return { source: "Docs", answer: "must not be used" };
    };
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-answers-off",
        userId: "U-answers-off",
        question: "how do I fix my board?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, false);
      assert.equal(answerCalls, 0);
      assert.ok(db.getTicketByThreadTs("t-answers-off"), "ticketing remains enabled independently");
    } finally {
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("a grounded answer opens a ticket that stays OPEN with a Mark as resolved button; resolve then reopen then resolve works", async () => {
  const db = require("./db");
  const tickets = require("./tickets");
  await withHelpProgram({ id: "grounded" }, async (programId, channel) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "export as PNG at native size" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({ client, channel, threadTs: "t-grounded-1", userId: "U-grounded", question: "how do I export my sprite?", mode: respond.HELP_ONLY });
      assert.equal(handled, true);

      const ticket = db.getTicketByThreadTs("t-grounded-1");
      assert.ok(ticket);
      assert.equal(ticket.status, "open", "answering never resolves or re-statuses the ticket");

      const uiMsg = client.posts.find((p) => /Someone will be here to help you soon/.test(p.text || ""));
      assert.ok(uiMsg, "the thread carries the open ticket UI");
      const resolveBtn = uiMsg.blocks.find((b) => b.type === "actions")?.elements.find((e) => e.action_id === "st_resolve");
      assert.ok(resolveBtn, "open state has one Mark as resolved button");

      // resolve
      const r1 = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-grounded", client });
      assert.equal(r1.ok, true);
      assert.equal(db.getTicket(ticket.id).status, "resolved");
      assert.equal(db.getTicket(ticket.id).resolved_by, "U-grounded");
      const afterResolve = client.posts.filter((p) => p.isUpdate).at(-1);
      assert.match(afterResolve.blocks.map((b) => JSON.stringify(b)).join(""), /Resolved by <@U-grounded>/);
      assert.ok(afterResolve.blocks.find((b) => b.type === "actions")?.elements.find((e) => e.action_id === "st_reopen"), "resolved state swaps in a Reopen button");
      assert.ok(!afterResolve.blocks.some((b) => (b.elements || []).some((e) => e.action_id === "st_resolve")), "no stale Mark as resolved button after resolve");

      // reopen
      const ro = await tickets.publicReopenTicket({ ticketId: ticket.id, actorId: "U-grounded", client });
      assert.equal(ro.ok, true);
      assert.equal(db.getTicket(ticket.id).status, "reopened");
      assert.equal(db.getTicket(ticket.id).reopen_count, 1);
      assert.match(client.posts.map((p) => p.text || "").join(" "), /Ticket reopened by <@U-grounded>/);

      // resolve again
      const r2 = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-grounded", client });
      assert.equal(r2.ok, true);
      assert.equal(db.getTicket(ticket.id).status, "resolved");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("resolving twice records one transition and posts one confirmation; an unauthorized user cannot resolve", async () => {
  const db = require("./db");
  const tickets = require("./tickets");
  await withHelpProgram({ id: "dblresolve" }, async (programId, channel) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "ok" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({ client, channel, threadTs: "t-dbl-1", userId: "U-owner", question: "how do rewards work?", mode: respond.HELP_ONLY });
      const ticket = db.getTicketByThreadTs("t-dbl-1");

      const stranger = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-random-nobody", client });
      assert.equal(stranger.error, "not_authorized");

      const first = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner", client });
      const second = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner", client });
      assert.equal(first.ok, true);
      assert.equal(second.deduped, true);
      const resolvedEvents = db.listTicketEvents(ticket.id).filter((e) => e.event_type === "resolved");
      assert.equal(resolvedEvents.length, 1, "exactly one persisted resolved transition");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("escalation reuses the SAME ticket created for the question — never a second one — and specialist routing runs only there", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "escreuse", autoAssign: true, organizerChannel: "C-escreuse-org" }, async (programId, channel) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
    const restoreCache = stubNoCache();
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
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

/* --------------------------------------------- per-program reply signature -- */

// The visible text of the answer Pixie actually posted, blocks first then the
// top-level fallback, skipping the "_thinking..._" placeholder and the support
// ticket UI ("Someone will be here to help you soon!" / "Resolved by …").
function answerText(client) {
  const isTicketUI = (p) => /Someone will be here to help you soon|Resolved by|Ticket reopened/i.test(p.text || "")
    || (p.blocks || []).some((b) => (b.elements || []).some((e) => /^st_/.test(e.action_id || "")));
  const real = client.posts.filter((p) => p.text !== "_thinking..._" && !isTicketUI(p));
  const post = real.find((p) => (p.blocks || []).some((b) => b.type === "section")) || real[0] || {};
  const section = (post.blocks || []).find((b) => b.type === "section");
  return (section && section.text && section.text.text) || post.text || "";
}

test("a program's reply signature ends its genuine answers (grounded and conversational)", async () => {
  const SIG = "stay wired :hardwire:";

  await withHelpProgram({ id: "hw-sig-grounded", replySignature: SIG }, async (programId, channel) => {
    const client = richClient();
    const oi = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "Tier 2 needs a testbench." }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({ client, channel, threadTs: "t-hwsig-1", userId: "U1", question: "does tier 2 need a testbench?", mode: respond.HELP_ONLY });
      assert.ok(answerText(client).trimEnd().endsWith(SIG), `grounded answer must end with the signature: ${answerText(client)}`);
    } finally { restoreAnswers(); intent.classifyIntent = oi; }
  });

  await withHelpProgram({ id: "hw-sig-chat", replySignature: SIG }, async (programId, channel) => {
    const client = richClient();
    const oi = intent.classifyIntent;
    // Chatter addressed at pixie -> general kind -> conversational reply.
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "yeah the iCE40 board handles that fine" }));
    try {
      await respond.respond({ client, channel, threadTs: "t-hwsig-2", userId: "U2", question: "mr.wire can i use the ice40 board for this", mode: respond.ALWAYS });
      assert.ok(answerText(client).trimEnd().endsWith(SIG), `conversational answer must end with the signature: ${answerText(client)}`);
    } finally { restoreAnswers(); intent.classifyIntent = oi; }
  });
});

test("the reply signature is never stapled to a fallback or an escalation acknowledgement", async () => {
  const SIG = "stay wired :hardwire:";

  // "not sure, ask a helper" human-defer fallback
  await withHelpProgram({ id: "hw-sig-fb", replySignature: SIG }, async (programId, channel) => {
    const client = richClient();
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
    const restoreCache = stubNoCache();
    try {
      await respond.respond({ client, channel, threadTs: "t-hwsig-3", userId: "U3", question: "mr.wire???", mode: respond.ALWAYS });
      assert.ok(!answerText(client).includes("stay wired"), "the human-defer fallback must not carry the catchphrase");
    } finally { restoreAnswers(); restoreCache(); }
  });

  // escalation acknowledgement to the requester
  await withHelpProgram({ id: "hw-sig-esc", replySignature: SIG, organizerChannel: "C-hw-sig-esc-org" }, async (programId, channel) => {
    const client = richClient();
    const oi = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
    const restoreCache = stubNoCache();
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({ client, channel, threadTs: "t-hwsig-4", userId: "U4", question: "my board is bricked and my deadline is tonight", mode: respond.HELP_ONLY });
      const everything = client.posts
        .map((p) => (p.text || "") + " " + (p.blocks || []).map((b) => (b.text && b.text.text) || (b.elements || []).map((e) => e.text || "").join(" ")).join(" "))
        .join("\n");
      assert.ok(!everything.includes("stay wired"), `escalation must stay serious, no catchphrase:\n${everything}`);
    } finally { restoreAnswers(); restoreCache(); intent.classifyIntent = oi; }
  });
});

test("reply signature stays scoped to its program — an unsigned program never inherits it", async () => {
  await withHelpProgram({ id: "pixl-unsigned" }, async (programId, channel) => {
    const client = richClient();
    const oi = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "export as PNG at native size" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({ client, channel, threadTs: "t-pixl-u1", userId: "U5", question: "how do I export my sprite?", mode: respond.HELP_ONLY });
      const body = answerText(client);
      assert.ok(!body.includes("stay wired") && !body.includes(":hardwire:"), `unsigned program must not inherit another program's catchphrase: ${body}`);
    } finally { restoreAnswers(); intent.classifyIntent = oi; }
  });
});

test("chatter addressed in a help channel gets a conversational reply but opens no ticket", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "chatter" }, async (programId, channel) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "haha yeah" }));
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const handled = await respond.respond({ client, channel, threadTs: "t-chatter-1", userId: "U-chatter", question: "sam are you coming to the call?", mode: respond.ALWAYS });
      assert.equal(handled, true); // pixie still replies — ALWAYS mode
      const ticket = db.getTicketByThreadTs("t-chatter-1");
      assert.equal(ticket, null, "chatter is not a support request, so no ticket");
      assert.match(client.posts.map((p) => p.text || "").join(" "), /haha yeah/);
    } finally {
      restoreAnswers();
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
  const originalIntent = intent.classifyIntent;
  const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "same answer for everyone" }));
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
    restoreAnswers();
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
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "still answering" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({ client, channel, threadTs: "t-notix-1", userId: "U-notix", question: "how do I get started", mode: respond.HELP_ONLY });
      assert.equal(handled, true);
      assert.equal(client.posts.length, 1, "pixie still replies");
      assert.equal(db.getTicketByThreadTs("t-notix-1"), null, "no ticket when public tickets are off");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("public_tickets_enabled=true (default): a same-thread follow-up reuses the existing ticket rather than opening a second one", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "dedupe" }, async (programId, channel) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    let answerText = "first answer";
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: answerText }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({ client, channel, threadTs: "t-dedupe-1", userId: "U-dedupe", question: "my board won't boot up at all", mode: respond.HELP_ONLY });
      const first = db.getTicketByThreadTs("t-dedupe-1");
      assert.ok(first);

      answerText = "a follow-up clarifying answer";
      await respond.respond({ client, channel, threadTs: "t-dedupe-1", userId: "U-dedupe", question: "what if I'm on a team?", mode: respond.HELP_ONLY });

      const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-dedupe-1");
      assert.equal(rows.length, 1, "the same thread must never produce a second ticket");
      assert.equal(rows[0].id, first.id);
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

/* --------------------------------- ANSWER PIPELINE characterization (audit) -- */
// Pinned before the respond.js gate/decide/compose/post split. Every test
// below asserts behavior the rewrite must preserve verbatim.

test("CHAR: HELP_ONLY answers HELP_NEEDED, drops on CASUAL_CHAT", async () => {
  await withHelpProgram({ id: "chargate" }, async (programId, channel) => {
    const originalIntent = intent.classifyIntent;
    try {
      // HELP_NEEDED verdict -> a ticket opens and the grounded answer posts
      // whole (ambient never streams: no text may show before the guards).
      let restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "held answer text" }));
      intent.classifyIntent = async () => intent.HELP_NEEDED;
      const clientOk = richClient();
      const handledOk = await respond.respond({ client: clientOk, channel, threadTs: "t-char-hold-1", userId: "U-char-hold", question: "how do i submit my project", mode: respond.HELP_ONLY });
      assert.equal(handledOk, true);
      assert.ok(clientOk.posts.length >= 1);
      assert.ok(clientOk.posts.some((p) => /held answer text/.test(p.text || "")));
      assert.ok(db.getTicketByThreadTs("t-char-hold-1"), "an engaged help question opens a ticket");
      restoreAnswers();

      // CASUAL_CHAT verdict -> dropped, silent, no ticket.
      restoreAnswers = stubAnswers(async () => ({ source: null, answer: "should never surface" }));
      intent.classifyIntent = async () => intent.CASUAL_CHAT;
      const clientDrop = richClient();
      const handledDrop = await respond.respond({ client: clientDrop, channel, threadTs: "t-char-drop-1", userId: "U-char-drop", question: "lol that game was wild", mode: respond.HELP_ONLY });
      assert.equal(handledDrop, false, "CASUAL_CHAT still suppresses Pixie's reply");
      assert.equal(db.getTicketByThreadTs("t-char-drop-1"), null, "casual chatter must not become a ticket");
      assert.ok(!clientDrop.posts.some((p) => /should never surface/.test(p.text || "")), "the dropped answer never surfaces");
      restoreAnswers();
    } finally {
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: HELP_ONLY classifier failure still tickets, and answers when grounded", async () => {
  await withHelpProgram({ id: "charnull" }, async (programId, channel) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "a docs answer" }));
    const restoreCache = stubNoCache();
    intent.classifyIntent = async () => null;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-null-1", userId: "U-char-null", question: "how do i submit", mode: respond.HELP_ONLY });
      assert.equal(handled, true, "a classifier outage must not swallow a help support request");
      assert.ok(db.getTicketByThreadTs("t-char-null-1"), "the ticket path needs no AI");
      assert.ok(client.posts.some((p) => /a docs answer/.test(p.text || "")), "a grounded answer still posts");
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("Jame Gam help still attempts its owned answer when intent classification fails", async () => {
  await withHelpProgram({ id: "jame-gam", name: "Jame Gam", sources: [{ name: "Jame Gam Complete Docs", type: "text", content: "Jame Gam answer" }] }, async (_programId, channel) => {
    const originalAnswer = answer.getAnswerOrChat;
    const originalIntent = intent.classifyIntent;
    let answerCalled = false;
    answer.getAnswerOrChat = async () => { answerCalled = true; return { source: "Jame Gam Complete Docs", answer: "Jame Gam answer" }; };
    intent.classifyIntent = async () => null;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-jame-null-1", userId: "U-jame-null", question: "what is jame gam", mode: respond.HELP_ONLY });
      assert.equal(handled, true);
      assert.equal(answerCalled, true);
    } finally {
      answer.getAnswerOrChat = originalAnswer;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: OFF_TOPIC in a help channel stays silent", async () => {
  await withHelpProgram({ id: "charoff", scope: "program" }, async (programId, channel) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({ source: null, answer: "that one belongs to another program, try their channel" });
    intent.classifyIntent = async () => intent.OFF_TOPIC;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-off-1", userId: "U-char-off", question: "what is the deadline for some other program", mode: respond.HELP_ONLY });
       assert.equal(handled, false, "OFF_TOPIC must not become an unsolicited answer");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: ALWAYS replies conversationally to chatter without opening a ticket", async () => {
  await withHelpProgram({ id: "charworthy" }, async (programId, channel) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "haha yeah" }));
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-worthy-1", userId: "U-char-worthy", question: "sam are you coming to the call?", mode: respond.ALWAYS });
      assert.equal(handled, true, "ALWAYS mode always replies");
      assert.equal(db.getTicketByThreadTs("t-char-worthy-1"), null, "chatter is a general reply, not a support request");
      assert.ok(client.posts.some((p) => /haha yeah/.test(p.text || "")));
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: chatter addressed at pixie opens no ticket; a real support question still does", async () => {
  await withHelpProgram({ id: "charground" }, async (programId, channel) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "export as PNG at native size" }));
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const client = richClient();
      await respond.respond({ client, channel, threadTs: "t-char-ground-2", userId: "U-char-g2", question: "png export lol", mode: respond.ALWAYS });
      assert.equal(db.getTicketByThreadTs("t-char-ground-2"), null, "addressed chatter is general chat, not a ticket");

      // The same channel, a real support question -> ticket, still OPEN.
      intent.classifyIntent = async () => intent.HELP_NEEDED;
      const client2 = richClient();
      await respond.respond({ client: client2, channel, threadTs: "t-char-ground-3", userId: "U-char-g3", question: "how do i export my sprite", mode: respond.ALWAYS });
      const ticket = db.getTicketByThreadTs("t-char-ground-3");
      assert.ok(ticket);
      assert.equal(ticket.status, "open");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: shadow program evaluates but posts nothing publicly", async () => {
  await withHelpProgram({ id: "charshadow", shadowMode: true }, async (programId, channel) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "a grounded answer" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const client = richClient();
      await respond.respond({ client, channel, threadTs: "t-char-shadow-1", userId: "U-char-shadow", question: "how do i submit", mode: respond.HELP_ONLY });
      assert.equal(client.posts.length, 0, "shadow mode sends nothing publicly");
      assert.equal(db.getTicketByThreadTs("t-char-shadow-1"), null, "shadow mode files no ticket");
    } finally {
      restoreAnswers();
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

test("CHAR: accepted support with model outage files a ticket and stays quiet", async () => {
  await withHelpProgram({ id: "charoutage" }, async (programId, channel) => {
      const original = answer.getAnswerOrChatStream;
      const originalLookup = lookup.answerOrChat;
      const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => { throw new Error("every provider is down"); };
      lookup.answerOrChat = async () => { throw new Error("every provider is down"); };
      intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-outage-1", userId: "U-char-outage", question: "how do i submit my project", mode: respond.HELP_ONLY });
      assert.equal(handled, false, "outage in help: ticket filed, no AI reply");
      assert.ok(db.getTicketByThreadTs("t-char-outage-1"), "outage must not swallow the support request");
    } finally {
      answer.getAnswerOrChatStream = original;
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("CHAR: HELP_ONLY suppresses hand-back clarification questions outside help", async () => {
  const originalIntent = intent.classifyIntent;
  // Non-help channel: use a bare program channel fixture instead.
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([{ id: "charhand", name: "charhand", channels: ["C-charhand"], guides: [] }]);
  programs.invalidate();
  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "sorry, what do you mean?" }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    const client = richClient();
    const handled = await respond.respond({ client, channel: "C-charhand", threadTs: "t-char-hand-1", userId: "U-char-hand", question: "eh how do i do this", mode: respond.HELP_ONLY });
    assert.equal(handled, false, "hand-back clarification stays quiet when unaddressed");
    assert.deepEqual(client.posts, [], "an ungrounded ambient answer is never posted");
  } finally {
    restoreAnswers();
    restoreCache();
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

test("CHAR: cache serves a grounded answer in help even when the classifier failed", async () => {
  await withHelpProgram({ id: "charcache" }, async (programId, channel) => {
    const originalIntent = intent.classifyIntent;
    const originalKnown = lookup.knownAnswer;
    // A grounded cache entry is servable: the help ticket path needs no
    // classifier, and only grounded-or-deterministic entries may serve a
    // program question.
    lookup.knownAnswer = () => ({ source: "Docs", answer: "cached answer here" });
    intent.classifyIntent = async () => null;
    try {
      const client = richClient();
      const handled = await respond.respond({ client, channel, threadTs: "t-char-cache-1", userId: "U-char-cache", question: "cached question here", mode: respond.HELP_ONLY });
      assert.equal(handled, true, "a grounded cached answer still serves the help request");
      assert.ok(db.getTicketByThreadTs("t-char-cache-1"), "the ticket path needs no AI");
      assert.ok(client.posts.some((p) => /cached answer here/.test(p.text || "")));
    } finally {
      lookup.knownAnswer = originalKnown;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("active incidents bypass cache and model work, stay tenant-scoped, and stop after resolution", async () => {
  const incidents = require("./incidents");
  const originalKnown = lookup.knownAnswer;
  const originalPlain = answer.getAnswerOrChat;
  const originalStream = answer.getAnswerOrChatStream;
  let cacheCalls = 0;
  let modelCalls = 0;
  lookup.knownAnswer = () => {
    cacheCalls += 1;
    return { source: "Docs", answer: "cached answer" };
  };
  answer.getAnswerOrChat = async () => {
    modelCalls += 1;
    return { source: "Docs", answer: "model answer" };
  };
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "Docs", answer: "model answer" };
  };
  try {
    await withHelpProgram({ id: "incident-respond" }, async (programId, channel) => {
      const created = incidents.createIncident({
        programId,
        title: "Pixl site is currently down",
        description: "People cannot access the website",
        publicMessage: "Heads up — the Pixl site is currently down; the team is on it.",
        actorId: "U-organizer",
      });
      const client = richClient();
      assert.equal(await respond.respond({ client, channel, threadTs: "t-incident-1", userId: "U-1", question: "pixl won't load", mode: respond.HELP_ONLY }), true);
      assert.equal(await respond.respond({ client, channel, threadTs: "t-incident-2", userId: "U-2", question: "cant open the website", mode: respond.HELP_ONLY }), true);
      assert.equal(cacheCalls, 0);
      assert.equal(modelCalls, 0);
      assert.equal(incidents.affectedReports(created.incident.id).length, 2);
      assert.equal(client.posts.filter((post) => /Pixl site is currently down/.test(post.text || "")).length, 2);

      await respond.respond({ client, channel, threadTs: "t-incident-unrelated", userId: "U-3", question: "when does review finish?", mode: respond.HELP_ONLY });
      assert.equal(client.posts.at(-1).text.includes("cached answer"), true);
      assert.equal(incidents.affectedReports(created.incident.id).length, 2);
      assert.equal(cacheCalls, 1);

      incidents.setIncidentStatus({ incidentId: created.incident.id, status: "resolved", actorId: "U-organizer" });
      await respond.respond({ client, channel, threadTs: "t-incident-resolved", userId: "U-4", question: "is the site down?", mode: respond.HELP_ONLY });
      assert.equal(client.posts.at(-1).text.includes("cached answer"), true);
      assert.equal(incidents.affectedReports(created.incident.id).length, 2);
      assert.equal(cacheCalls, 2);
      assert.equal(modelCalls, 0);
    });
  } finally {
    lookup.knownAnswer = originalKnown;
    answer.getAnswerOrChat = originalPlain;
    answer.getAnswerOrChatStream = originalStream;
  }
});
