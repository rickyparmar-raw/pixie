process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const { config } = require("./config");
const handlers = require("./handlers");
const context = require("./context");
const respond = require("./respond");
const learn = require("./learn");
const vision = require("./vision");

db.open(":memory:");
config.slack.botUserId = "U0PIXIE";

test("mentionsPixieByName matches the name and its suffixes", () => {
  assert.equal(handlers.mentionsPixieByName("pixie help"), true);
  assert.equal(handlers.mentionsPixieByName("hey Pixie!"), true);
  assert.equal(handlers.mentionsPixieByName("pixies are cool"), true);
});

test("mentionsPixieByName ignores unrelated text", () => {
  assert.equal(handlers.mentionsPixieByName("pixl is great"), false);
  assert.equal(handlers.mentionsPixieByName(""), false);
  assert.equal(handlers.mentionsPixieByName(undefined), false);
});

test("mentionsPixieByName follows the configured bot identity", () => {
  const savedName = process.env.PIXIE_BOT_NAME;
  const savedSlug = process.env.PIXIE_BOT_SLUG;
  process.env.PIXIE_BOT_NAME = "Live Helper";
  process.env.PIXIE_BOT_SLUG = "live-helper";
  try {
    assert.equal(handlers.mentionsPixieByName("live helper can you help?"), true);
    assert.equal(handlers.mentionsPixieByName("pixie can you help?"), false);
  } finally {
    if (savedName === undefined) delete process.env.PIXIE_BOT_NAME;
    else process.env.PIXIE_BOT_NAME = savedName;
    if (savedSlug === undefined) delete process.env.PIXIE_BOT_SLUG;
    else process.env.PIXIE_BOT_SLUG = savedSlug;
  }
});

// This used to build `<@undefined>` because the bot user ID was read off the
// wrong object, so a real @-mention never matched.
test("mentionsPixieDirectly matches the resolved bot user id", () => {
  assert.equal(handlers.mentionsPixieDirectly("<@U0PIXIE> whats up"), true);
  assert.equal(handlers.mentionsPixieDirectly("<@U0SOMEONE> whats up"), false);
});

test("mentionsPixieDirectly is false when the bot id is unresolved", () => {
  const saved = config.slack.botUserId;
  config.slack.botUserId = null;
  try {
    assert.equal(handlers.mentionsPixieDirectly("<@undefined> hi"), false);
  } finally {
    config.slack.botUserId = saved;
  }
});

test("stripBotMention removes every ping and trims", () => {
  assert.equal(handlers.stripBotMention("<@U0PIXIE> how do i join <@U0PIXIE>"), "how do i join");
});

// Another human being @-mentioned must not suppress the answer — the old
// blanket `<@U` check dropped those messages entirely.
test("stripBotMention leaves other people's mentions intact", () => {
  assert.equal(handlers.stripBotMention("<@U0PIXIE> ask <@U0ALEX> about it"), "ask <@U0ALEX> about it");
});

test("shouldConsiderThreadReply allows all top-level messages", () => {
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "1.1", text: "hi" }), true);
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "1.1", thread_ts: "1.1", text: "hi" }), true);
});

// The expensive case: a thread pixie has nothing to do with should never cost
// an intent call.
test("shouldConsiderThreadReply skips threads pixie has not spoken in", () => {
  assert.equal(
    handlers.shouldConsiderThreadReply({ ts: "2.2", thread_ts: "1.1", text: "lol same" }),
    false,
  );
});

test("shouldConsiderThreadReply allows a thread reply that names or pings pixie", () => {
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "2.2", thread_ts: "1.1", text: "pixie help" }), true);
  assert.equal(
    handlers.shouldConsiderThreadReply({ ts: "2.2", thread_ts: "1.1", text: "<@U0PIXIE> help" }),
    true,
  );
});

test("shouldConsiderThreadReply allows a thread pixie already replied in", () => {
  context.addToThread("thread-spoken", "assistant", "here you go", null, "C1");
  assert.equal(
    handlers.shouldConsiderThreadReply({ ts: "3.3", thread_ts: "thread-spoken", text: "thanks" }),
    true,
  );
});

test("shouldConsiderThreadReply skips unaddressed thread when PIXIE_THREAD_REQUIRE_MENTION is set", () => {
  const origEnv = process.env.PIXIE_THREAD_REQUIRE_MENTION;
  try {
    process.env.PIXIE_THREAD_REQUIRE_MENTION = "1";
    context.addToThread("thread-spoken-req", "assistant", "here you go", null, "C1");
    assert.equal(
      handlers.shouldConsiderThreadReply({ ts: "4.4", thread_ts: "thread-spoken-req", text: "asking another human" }),
      false,
    );
    assert.equal(
      handlers.shouldConsiderThreadReply({ ts: "4.4", thread_ts: "thread-spoken-req", text: "pixie help" }),
      true,
    );
  } finally {
    process.env.PIXIE_THREAD_REQUIRE_MENTION = origEnv;
  }
});

test("mentionsPixieByName supports PIXIE_BOT_ALIASES", () => {
  const origAliases = process.env.PIXIE_BOT_ALIASES;
  try {
    process.env.PIXIE_BOT_ALIASES = "seb,seba,sebastian";
    assert.equal(handlers.mentionsPixieByName("hey seb check this"), true);
    assert.equal(handlers.mentionsPixieByName("sebastian what is live"), true);
    assert.equal(handlers.mentionsPixieByName("hey bob check this"), false);
  } finally {
    process.env.PIXIE_BOT_ALIASES = origAliases;
  }
});

test("findImage picks the first image with a private URL", () => {
  assert.equal(handlers.findImage({}), null);
  assert.equal(handlers.findImage({ files: [] }), null);
  assert.equal(handlers.findImage({ files: [{ mimetype: "application/pdf", url_private: "u" }] }), null);

  const image = { mimetype: "image/png", url_private: "https://files.slack.com/x.png" };
  assert.equal(handlers.findImage({ files: [{ mimetype: "text/plain" }, image] }), image);
});

/* ----------------------------------------------------- mention with image -- */

// Slack fires both `message` and `app_mention` for "@pixie <screenshot>" and
// both claim the same ts, so whichever arrives first decides the reply. Only
// onMessage looked for an image, so app_mention winning produced "I can't
// actually see images" on a message that plainly had one.
test("onAppMention analyses an attached image instead of replying blind", async () => {
  const savedRespond = respond.respond;
  const savedVision = vision.analyzeImage;
  const savedHelp = config.slack.helpChannel;
  const posted = [];
  let visionSawQuestion = null;

  respond.respond = async () => {
    throw new Error("an image mention must not fall through to the text path");
  };
  vision.analyzeImage = async (_url, question) => {
    visionSawQuestion = question;
    return "that's a photo of a breadboard";
  };
  // Scope gate: an @-mention only reaches any handling in a channel Pixie is
  // actually configured for — C0MENTION stands in for that here.
  config.slack.helpChannel = "C0MENTION";

  try {
    await handlers.onAppMention({
      event: {
        ts: "500.1",
        channel: "C0MENTION",
        user: "U0ASKER",
        text: "<@U0PIXIE> bruda cant u see the IMAGE",
        files: [{ mimetype: "image/png", url_private: "https://files.slack.com/x.png" }],
      },
      client: { chat: { postMessage: async (args) => void posted.push(args) } },
    });
  } finally {
    respond.respond = savedRespond;
    vision.analyzeImage = savedVision;
    config.slack.helpChannel = savedHelp;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /breadboard/);
  // The raw "<@U0PIXIE>" would otherwise read as part of the question.
  assert.equal(visionSawQuestion, "bruda cant u see the IMAGE");
});

test("onAppMention still uses the text path when there is no image", async () => {
  const savedRespond = respond.respond;
  const savedHelp = config.slack.helpChannel;
  const calls = [];
  respond.respond = async (args) => void calls.push(args);
  config.slack.helpChannel = "C0MENTION";

  try {
    await handlers.onAppMention({
      event: { ts: "501.1", channel: "C0MENTION", user: "U0ASKER", text: "<@U0PIXIE> how do i ship" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
    config.slack.helpChannel = savedHelp;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.equal(calls[0].question, "how do i ship");
});

/* -------------------------------------------- help channel thread replies -- */

// Thread replies in the help channel were dropped before any gate ran, so a
// correction to pixie's own answer never reached it — pixie kept the last word
// while being wrong. These cover every way a help-channel message can land.
const HELP_CHANNEL = "C0HELP";

// onMessage reaches the network twice over — respond() answers and
// learn.captureFromReply judges the reply. Both are stubbed so these tests
// assert routing only.
async function routeHelpMessage(event) {
  const savedHelp = config.slack.helpChannel;
  const savedAuto = config.slack.autoReplyChannel;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  const calls = [];
  config.slack.helpChannel = HELP_CHANNEL;
  config.slack.autoReplyChannel = "C0FAQ";
  respond.respond = async (args) => void calls.push(args);
  learn.captureFromReply = async () => null;

  try {
    await handlers.onMessage({
      event: { channel: HELP_CHANNEL, user: "U0ASKER", ...event },
      client: {},
    });
    return calls;
  } finally {
    config.slack.helpChannel = savedHelp;
    config.slack.autoReplyChannel = savedAuto;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }
}

test("help channel still answers a top-level post", async () => {
  const calls = await routeHelpMessage({ ts: "100.1", text: "how do i submit my project" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.ALWAYS);
  // Nothing to seed from — the post is the whole thread.
  assert.equal(calls[0].seedClient, null);
});

test("explicit human review requests escalate once without calling the provider", async () => {
  const programs = require("./programs");
  const savedForChannel = programs.forChannel;
  const savedIsHelp = programs.isHelpChannel;
  const savedRespond = respond.respond;
  const posted = [];
  const program = {
    id: "sandbox-escalation",
    name: "Pixie Sandbox",
    supportName: "Sandbox Help",
    posture: "active",
    ticketsEnabled: true,
    autoEscalate: true,
    helpChannel: HELP_CHANNEL,
    organizerChannel: "C0ORGANIZER",
  };
  programs.forChannel = () => program;
  programs.isHelpChannel = (channel) => channel === HELP_CHANNEL;
  respond.respond = async () => { throw new Error("terminal human review must not call provider"); };
  const client = { chat: { postMessage: async (args) => { posted.push(args); return { ts: `posted-${posted.length}` }; } } };
  const event = {
    ts: "human-escalation-1",
    channel: HELP_CHANNEL,
    user: "U0ASKER",
    team: "T-ESCALATION",
    text: "human please — i can't access my pixl account and need an organizer to look at it",
  };
  try {
    await handlers.onMessage({ event, client });
    await handlers.onMessage({ event, client });
  } finally {
    programs.forChannel = savedForChannel;
    programs.isHelpChannel = savedIsHelp;
    respond.respond = savedRespond;
  }
  const ticket = db.getTicketByThreadTs(event.ts, event.team);
  assert.ok(ticket);
  assert.equal(posted.length, 2, "one public acknowledgement and one organizer card");
  assert.equal(posted.filter((p) => p.channel === HELP_CHANNEL).length, 1);
  assert.equal(posted.filter((p) => p.channel === "C0ORGANIZER").length, 1);
  assert.match(posted.find((p) => p.channel === HELP_CHANNEL).text, /Someone will be here to help you soon/);
  assert.match(posted.find((p) => p.channel === "C0ORGANIZER").text, new RegExp(`Ticket #${ticket.id}`));
});

test("help channel routes unaddressed thread follow-up to HELP_ONLY gate", async () => {
  context.addToThread("200.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const calls = await routeHelpMessage({
    ts: "200.2",
    thread_ts: "200.1",
    text: "i tried running that but got permission denied, what should i do?",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  assert.equal(calls[0].addressed, false);
  assert.ok(calls[0].seedClient);
});

test("help channel skips a thread reply that has no content signal", async () => {
  context.addToThread("300.1", "assistant", "try reinstalling the extension", null, HELP_CHANNEL);
  const calls = await routeHelpMessage({
    ts: "300.2",
    thread_ts: "300.1",
    text: "👍",
  });
  assert.equal(calls.length, 0);
  assert.match(context.getThreadContext("300.1"), /👍/);
});

test("help channel answers a thread reply that names pixie", async () => {
  const calls = await routeHelpMessage({
    ts: "400.2",
    thread_ts: "400.1",
    text: "pixie, i still can't connect my keyboard",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.equal(calls[0].threadTs, "400.1");
  assert.ok(calls[0].seedClient);
});

/* --------------------------------------------- thread transcript recall --- */

// Pixie used to only remember messages it actually replied to — a thread
// reply it stayed quiet on vanished from context.getThreadContext entirely,
// so a real question later in the same thread had no idea the chatter ever
// happened. These cover the two spots that were silently dropping messages.

test("help channel hands an unnamed thread reply to the gate once pixie has spoken there", async () => {
  context.addToThread("700.1", "assistant", "try reinstalling the extension", null, HELP_CHANNEL);

  const calls = await routeHelpMessage({
    ts: "700.2",
    thread_ts: "700.1",
    text: "still not working, tried that already",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  assert.equal(calls[0].addressed, false);
});

// The existing "never spoke in" case must stay a true no-op — two humans
// working a problem out in a thread pixie was never part of is not her
// context to keep.
test("help channel does not record an unnamed thread reply in a thread pixie never spoke in", async () => {
  const calls = await routeHelpMessage({
    ts: "800.2",
    thread_ts: "800.1",
    text: "did you try reseating the cable?",
  });

  assert.equal(calls.length, 0);
  assert.equal(context.getThreadContext("800.1"), null);
});

// The regex gate that used to sit here dropped this on the word "lol" and
// never asked anyone. Deciding that from one message was the whole problem —
// "lol thanks so much for that" and "lol so it still wont build" are the same
// shape — so anything with words in it now goes to the classifier, which gets
// to see what this person said just before.
test("faqChannels hands a low-signal reply to the gate instead of dropping it", async () => {
  const FAQ_CHANNEL = "C0FAQTX";
  const savedFaq = config.slack.faqChannels;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  config.slack.faqChannels = [FAQ_CHANNEL];
  let mode = null;
  respond.respond = async (args) => {
    mode = args.mode;
    return true;
  };
  learn.captureFromReply = async () => null;

  context.addToThread("faq-thread-1", "assistant", "here's how you do it", null, FAQ_CHANNEL);

  try {
    await handlers.onMessage({
      event: {
        ts: "600.2",
        thread_ts: "faq-thread-1",
        channel: FAQ_CHANNEL,
        user: "U0ASKER",
        text: "lol thanks so much for that",
      },
      client: {},
    });
  } finally {
    config.slack.faqChannels = savedFaq;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }

  assert.equal(mode, respond.HELP_ONLY, "the gate decides, not a pattern over the message");
});

// The one thing still decided locally: a message with no words in it is not
// worth a model call. It is recorded so the thread reads correctly, and that
// is all.
test("faqChannels still drops a bare reaction without calling the model", async () => {
  const FAQ_CHANNEL = "C0FAQTY";
  const savedFaq = config.slack.faqChannels;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  config.slack.faqChannels = [FAQ_CHANNEL];
  respond.respond = async () => {
    throw new Error("should not respond — the message is a bare reaction");
  };
  learn.captureFromReply = async () => null;

  context.addToThread("faq-thread-2", "assistant", "here's how you do it", null, FAQ_CHANNEL);

  try {
    await handlers.onMessage({
      event: {
        ts: "601.2",
        thread_ts: "faq-thread-2",
        channel: FAQ_CHANNEL,
        user: "U0ASKER2",
        text: "lmaooo :yay:",
      },
      client: {},
    });
  } finally {
    config.slack.faqChannels = savedFaq;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }

  assert.match(context.getThreadContext("faq-thread-2"), /lmaooo/);
});

// Every human message is recorded, replied to or not — the gate reads the
// three before the one it is judging, and pixie is silent for most of them.
test("onMessage records what people say even when it stays quiet", async () => {
  const FAQ_CHANNEL = "C0FAQTZ";
  const savedFaq = config.slack.faqChannels;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  config.slack.faqChannels = [FAQ_CHANNEL];
  respond.respond = async () => true;
  learn.captureFromReply = async () => null;

  try {
    for (const [i, text] of ["my build broke", "tried reinstalling", "still nothing"].entries()) {
      await handlers.onMessage({
        event: { ts: `70${i}.1`, channel: FAQ_CHANNEL, user: "U0DEBUG", text },
        client: {},
      });
    }
  } finally {
    config.slack.faqChannels = savedFaq;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }

  const recent = db.recentUserMessages("U0DEBUG", { channel: FAQ_CHANNEL, limit: 3 });
  assert.deepEqual(
    recent.map((r) => r.text),
    ["my build broke", "tried reinstalling", "still nothing"],
    "oldest first, ready to paste into the gate prompt",
  );
});

/* ------------------------------------------------------- guide reactions -- */

test("onReactionAdded advances a guide when :upvote: lands on its own tracked message", async () => {
  const guides = require("./guides");
  guides.startGuide("submit-ysws-guidelines", "thread-reaction-advance", "U-owner");
  db.setGuideMessageTs("thread-reaction-advance", "700.1");

  const posted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "upvote",
      user: "U-owner",
      item: { type: "message", channel: "C0GUIDE", ts: "700.1" },
      item_user: "U0PIXIE",
    },
    client: { chat: { postMessage: async (args) => { posted.push(args); return { ts: "700.2" }; } } },
  });

  assert.equal(posted.length, 1, "the next step should have been posted");
  assert.equal(db.getGuide("thread-reaction-advance").current_step, 1);
  // The new step's own message is now the one tracked, not the old one.
  assert.equal(db.getGuideByMessageTs("700.2").thread_ts, "thread-reaction-advance");
});

test("onReactionAdded ignores :upvote: from someone other than the guide's owner", async () => {
  const guides = require("./guides");
  guides.startGuide("submit-ysws-guidelines", "thread-reaction-other", "U-owner");
  db.setGuideMessageTs("thread-reaction-other", "701.1");

  const posted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "upvote",
      user: "U-bystander",
      item: { type: "message", channel: "C0GUIDE", ts: "701.1" },
      item_user: "U0PIXIE",
    },
    client: { chat: { postMessage: async (args) => { posted.push(args); return { ts: "701.2" }; } } },
  });

  assert.equal(posted.length, 0, "a bystander's reaction must not advance someone else's guide");
  assert.equal(db.getGuide("thread-reaction-other").current_step, 0);
});

test("onReactionAdded still records ordinary feedback when :upvote: lands on a non-guide message", async () => {
  const savedRecordFeedback = db.recordFeedback;
  const calls = [];
  db.recordFeedback = (...args) => calls.push(args);

  try {
    await handlers.onReactionAdded({
      event: {
        reaction: "upvote",
        user: "U-fan",
        item: { type: "message", channel: "C0DOCS", ts: "702.1" },
        item_user: "U0PIXIE",
      },
      client: {},
    });
  } finally {
    db.recordFeedback = savedRecordFeedback;
  }

  assert.deepEqual(calls, [["702.1", "U-fan", 1]]);
});

/* --------------------------------------------------------- delete reaction -- */

// reaction_added carries the channel on event.item.channel; there is no
// top-level event.channel. Reading the wrong one made every lookup below run
// with channel: undefined, and the Slack error was swallowed at log.debug, so
// :pixl-delete: did nothing and said nothing.
test("onReactionAdded deletes pixie's own message on :pixl-delete:", async () => {
  const deleted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "pixl-delete",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "800.1" },
    },
    client: {
      conversations: {
        history: async (args) => {
          assert.equal(args.channel, "C0DEL", "history must read the item's channel");
          return { messages: [{ user: "U0PIXIE", ts: "800.1" }] };
        },
      },
      chat: { delete: async (args) => { deleted.push(args); return { ok: true }; } },
    },
  });

  assert.equal(deleted.length, 1, "pixie's own message should have been deleted");
  assert.equal(deleted[0].channel, "C0DEL");
  assert.equal(deleted[0].ts, "800.1");
});

test("onReactionAdded deletes pixie's own message on :x:", async () => {
  const deleted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "x",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "800.2" },
    },
    client: {
      conversations: {
        history: async (args) => {
          assert.equal(args.channel, "C0DEL");
          return { messages: [{ user: "U0PIXIE", ts: "800.2" }] };
        },
      },
      chat: { delete: async (args) => { deleted.push(args); return { ok: true }; } },
    },
  });

  assert.equal(deleted.length, 1, "message should have been deleted on :x:");
  assert.equal(deleted[0].channel, "C0DEL");
  assert.equal(deleted[0].ts, "800.2");
});

test("onReactionAdded does not delete a message pixie did not write", async () => {
  const deleted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "pixl-delete",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "801.1" },
    },
    client: {
      conversations: { history: async () => ({ messages: [{ user: "U-human", ts: "801.1" }] }) },
      chat: { delete: async (args) => { deleted.push(args); return { ok: true }; } },
    },
  });

  assert.equal(deleted.length, 0, "only pixie's own messages may be deleted this way");
});

// Same root cause, second symptom: the next guide step was posted to
// channel: undefined.
test("onReactionAdded posts the next guide step to the item's channel", async () => {
  const guides = require("./guides");
  guides.startGuide("submit-ysws-guidelines", "thread-reaction-channel", "U-owner");
  db.setGuideMessageTs("thread-reaction-channel", "802.1");

  const posted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "upvote",
      user: "U-owner",
      item: { type: "message", channel: "C0GUIDE", ts: "802.1" },
      item_user: "U0PIXIE",
    },
    client: { chat: { postMessage: async (args) => { posted.push(args); return { ts: "802.2" }; } } },
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].channel, "C0GUIDE", "the step must go to the channel the reaction was in");
});

// conversations.history only returns top-level channel messages, never thread
// replies — and pixie answers in threads. Looking the message up by ts found
// nothing, so the ownership check failed and the delete silently did not
// happen. It also needed channel membership pixie does not always have.
// reaction_added already carries item_user, the message's author, so no
// lookup is needed at all.
test("onReactionAdded deletes a threaded reply using item_user, with no history call", async () => {
  const deleted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "pixl-delete",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "900.1" },
      item_user: "U0PIXIE",
    },
    client: {
      conversations: { history: async () => { throw new Error("history must not be called"); } },
      chat: { delete: async (args) => { deleted.push(args); return { ok: true }; } },
    },
  });

  assert.equal(deleted.length, 1, "a threaded reply by pixie should still be deletable");
  assert.equal(deleted[0].channel, "C0DEL");
  assert.equal(deleted[0].ts, "900.1");
});

test("onReactionAdded ignores :pixl-delete: on a message item_user says is not pixie's", async () => {
  const deleted = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "pixl-delete",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "901.1" },
      item_user: "U-human",
    },
    client: {
      conversations: { history: async () => { throw new Error("history must not be called"); } },
      chat: { delete: async (args) => { deleted.push(args); return { ok: true }; } },
    },
  });

  assert.equal(deleted.length, 0);
});

test("a broadcast thread reply routes once like a normal thread reply", async () => {
  context.addToThread("900.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const calls = await routeHelpMessage({
    ts: "900.2",
    thread_ts: "900.1",
    subtype: "thread_broadcast",
    text: "tried that, still getting the same error, what next?",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
});

test("a broadcast can never file a second ticket for its thread", async () => {
  const tickets = require("./tickets");
  const nope = { chat: { postMessage: async () => ({ ts: "card-1" }) } };
  const prog = { id: "bc", name: "Bc", posture: "active", helpChannel: "C-BC" };
  const first = await tickets.escalateTicket({ program: prog, channel: "C-BC", threadTs: "bc-1", requesterId: "U1", question: "help", client: nope, workspaceId: "TBC" });
  const second = await tickets.escalateTicket({ program: prog, channel: "C-BC", threadTs: "bc-1", requesterId: "U1", question: "help", client: nope, workspaceId: "TBC" });
  assert.equal(first.id, second.id);
});

test("message edits and deletes stay silent and file nothing", async () => {
  const changed = await routeHelpMessage({ ts: "910.1", subtype: "message_changed", text: "how do i submit" });
  assert.equal(changed.length, 0);
  const deleted = await routeHelpMessage({ ts: "910.2", subtype: "message_deleted", text: "" });
  assert.equal(deleted.length, 0);
});

test("takeover cue parks the thread until Pixie is invited back", async () => {
  context.addToThread("800.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const cue = await routeHelpMessage({ ts: "800.2", thread_ts: "800.1", text: "I'll handle this" });
  assert.equal(cue.length, 0);
  assert.equal(db.isTakeover("800.1"), true);

  const chatter = await routeHelpMessage({ ts: "800.3", thread_ts: "800.1", text: "any update?" });
  assert.equal(chatter.length, 0, "takeover stays silent");

  const back = await routeHelpMessage({ ts: "800.4", thread_ts: "800.1", text: "pixie come back, need you" });
  assert.equal(back.length, 1);
  assert.equal(db.isTakeover("800.1"), false);
});

test("muted thread reactivates only on explicit invitation", async () => {
  db.muteThread("801.1", HELP_CHANNEL);
  try {
    const quiet = await routeHelpMessage({ ts: "801.2", thread_ts: "801.1", text: "what about the pcb" });
    assert.equal(quiet.length, 0);
    const invited = await routeHelpMessage({ ts: "801.3", thread_ts: "801.1", text: "pixie help" });
    assert.equal(invited.length, 1);
    assert.equal(db.isThreadMuted("801.1"), false);
  } finally {
    db.unmuteThread("801.1");
  }
});

test("redelivered events never double-answer", async () => {
  const first = await routeHelpMessage({ ts: "802.1", text: "how do i submit my project" });
  assert.equal(first.length, 1);
  const second = await routeHelpMessage({ ts: "802.1", text: "how do i submit my project" });
  assert.equal(second.length, 0);
});

test("onAppMention answers once in a muted thread without clearing the mute", async () => {
  const savedRespond = respond.respond;
  const savedHelp = config.slack.helpChannel;
  const calls = [];
  respond.respond = async (args) => void calls.push(args);
  config.slack.helpChannel = "C0MENTION";
  db.muteThread("810.1", "C0MENTION");
  try {
    await handlers.onAppMention({
      event: { ts: "810.2", thread_ts: "810.1", channel: "C0MENTION", user: "U0ASKER", text: "<@U0PIXIE> is pcbway allowed?" },
      client: {},
    });
    assert.equal(calls.length, 1);
    assert.equal(db.isThreadMuted("810.1"), true);
  } finally {
    respond.respond = savedRespond;
    config.slack.helpChannel = savedHelp;
    db.unmuteThread("810.1");
  }
});

test("onAppMention reactivates a muted thread only on explicit invitation", async () => {
  const savedRespond = respond.respond;
  const savedHelp = config.slack.helpChannel;
  const calls = [];
  respond.respond = async (args) => void calls.push(args);
  config.slack.helpChannel = "C0MENTION";
  db.muteThread("811.1", "C0MENTION");
  try {
    await handlers.onAppMention({
      event: { ts: "811.2", thread_ts: "811.1", channel: "C0MENTION", user: "U0ASKER", text: "<@U0PIXIE> come back" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
    config.slack.helpChannel = savedHelp;
  }
  assert.equal(calls.length, 1);
  assert.equal(db.isThreadMuted("811.1"), false);
});

test("staging allowlist drops non-sandbox channels before any handling", async () => {
  const saved = config.slack.stagingOnlyChannels;
  const savedFaq = config.slack.faqChannels;
  config.slack.stagingOnlyChannels = ["C0C04LB6VA5"];
  // Scope gate: the sandbox channel also has to be one Pixie is configured
  // for, same as any real channel would need to be — using faqChannels
  // rather than helpChannel here because routeHelpMessage's own save/restore
  // of config.slack.helpChannel would otherwise clobber it mid-test.
  config.slack.faqChannels = ["C0C04LB6VA5"];
  try {
    const prod = await routeHelpMessage({ ts: "950.1", channel: "C0PIXEL", text: "pixie how do i submit my project" });
    assert.equal(prod.length, 0, "production channel event must not be handled in staging");
    const sandbox = await routeHelpMessage({ ts: "950.2", channel: "C0C04LB6VA5", text: "pixie how do i submit my project" });
    assert.equal(sandbox.length, 1, "sandbox channel event is handled");
  } finally {
    config.slack.stagingOnlyChannels = saved;
    config.slack.faqChannels = savedFaq;
  }
});

/* ------------------------------------------- unclaimed-channel silence -- */

// Being invited to a channel (any workspace admin can do that) must never
// imply scope. Only an explicit claim (help channel, a program's own
// channels, or faqChannels) does. Before this gate existed, naming or
// @-mentioning Pixie in literally any channel it was a member of produced a
// full answer — and could escalate a real ticket — regardless of whether
// that channel had ever been configured for it.
test("a plain message naming Pixie in an unclaimed channel gets total silence", async () => {
  const savedRespond = respond.respond;
  const posted = [];
  respond.respond = async (args) => void posted.push(args);
  try {
    await handlers.onMessage({
      event: { ts: "990.1", channel: "C0RANDOM-UNCLAIMED", user: "U0ASKER", text: "pixie, what do you think about this pcb layout?" },
      client: { chat: { postMessage: async (args) => void posted.push(args), postEphemeral: async (args) => void posted.push(args) } },
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(posted.length, 0, "no reply, no escalation, nothing — the channel was never claimed");
});

test("an @-mention in an unclaimed channel gets total silence, even a sensitive one", async () => {
  const savedRespond = respond.respond;
  const posted = [];
  respond.respond = async (args) => void posted.push(args);
  try {
    await handlers.onAppMention({
      event: { ts: "991.1", channel: "C0RANDOM-UNCLAIMED-2", user: "U0ASKER", text: "<@U0PIXIE> is anyone else having thoughts of self harm" },
      client: { chat: { postMessage: async (args) => void posted.push(args), postEphemeral: async (args) => void posted.push(args) } },
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(posted.length, 0, "no answer, no escalation ticket — an unclaimed channel gets nothing");
  assert.equal(db.getTicketByThreadTs("991.1", undefined), null, "no ticket was filed for the unclaimed channel");
});

test("a DM still works — the scope gate is channel-only, not global", async () => {
  const savedRespond = respond.respond;
  const calls = [];
  respond.respond = async (args) => void calls.push(args);
  try {
    await handlers.onMessage({
      event: { ts: "992.1", channel: "D0DM-CHANNEL", channel_type: "im", user: "U0ASKER", text: "how do i submit my project" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(calls.length, 1, "DMs are exempt from channel-claim scoping");
  assert.equal(calls[0].mode, respond.ALWAYS);
});

/* ------------------------------ ANSWER PIPELINE characterization (audit) -- */

test("CHAR: onAppMention routes to respond ALWAYS addressed (mention path parity)", async () => {
  const savedRespond = respond.respond;
  const calls = [];
  respond.respond = async (args) => void calls.push(args);
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([{ id: "charmen", name: "CharMen", helpChannel: "C-CHARMEN", channels: ["C-CHARMEN"], guides: [] }]);
  programs.invalidate();
  try {
    await handlers.onAppMention({
      event: { ts: "993.1", channel: "C-CHARMEN", user: "U0ASKER", text: "<@U0PIXIE> how do i submit" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.equal(calls[0].addressed, true);
});
