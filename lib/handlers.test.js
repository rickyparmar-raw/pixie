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
  const posted = [];
  let visionSawQuestion = null;

  respond.respond = async () => {
    throw new Error("an image mention must not fall through to the text path");
  };
  vision.analyzeImage = async (_url, question) => {
    visionSawQuestion = question;
    return "that's a photo of a breadboard";
  };

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
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /breadboard/);
  // The raw "<@U0PIXIE>" would otherwise read as part of the question.
  assert.equal(visionSawQuestion, "bruda cant u see the IMAGE");
});

test("onAppMention still uses the text path when there is no image", async () => {
  const savedRespond = respond.respond;
  const calls = [];
  respond.respond = async (args) => void calls.push(args);

  try {
    await handlers.onAppMention({
      event: { ts: "501.1", channel: "C0MENTION", user: "U0ASKER", text: "<@U0PIXIE> how do i ship" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
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
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  // Nothing to seed from — the post is the whole thread.
  assert.equal(calls[0].seedClient, null);
});

// The regression this whole change exists for: pixie answered, a human pushed
// back in the thread, and pixie never saw it.
test("help channel answers a thread reply where pixie already spoke", async () => {
  context.addToThread("200.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const calls = await routeHelpMessage({
    ts: "200.2",
    thread_ts: "200.1",
    text: "stfu they do have everything connected, i still can't connect my keyboard",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  assert.equal(calls[0].threadTs, "200.1");
  // A follow-up only makes sense with the thread above it in context.
  assert.ok(calls[0].seedClient);
});

// Two humans working a problem out are still left alone.
test("help channel ignores a thread reply where pixie never spoke", async () => {
  const calls = await routeHelpMessage({
    ts: "300.2",
    thread_ts: "300.1",
    text: "did you try reseating the cable?",
  });
  assert.equal(calls.length, 0);
});

// Pixie owning the thread is not a licence to answer every "same lol" in it.
test("help channel skips the model call for banter in its own thread", async () => {
  context.addToThread("400.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const before = db.metricDetails("silent").find((r) => r.detail === "not_a_question")?.count || 0;

  const calls = await routeHelpMessage({ ts: "400.2", thread_ts: "400.1", text: "same lol" });

  assert.equal(calls.length, 0);
  const after = db.metricDetails("silent").find((r) => r.detail === "not_a_question")?.count || 0;
  assert.equal(after, before + 1, "the skip should be attributable in the silence log");
});
