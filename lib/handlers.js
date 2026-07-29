// Slack event routing. Decides *whether* pixie should speak; lib/respond.js
// decides what it says.
const { config } = require("./config");
const { analyzeImage } = require("./vision");
const { classifyIntent, couldNeedHelp, HELP_NEEDED } = require("./intent");
const context = require("./context");
const respond = require("./respond");
const learn = require("./learn");
const db = require("./db");
const log = require("./log");

const PIXIE_NAME_PATTERN = /\bpixie\w*\b/i;
const DELETE_REACTION = "pixl-delete";
const UP_REACTIONS = new Set(["yay", "thumbs-up", "+1", "yesyes", "white_check_mark", "heavy_check_mark", "upvote", "sparkling_heart", "heart", "heart_eyes"]);
const DOWN_REACTIONS = new Set(["nono", "-1", "thumbsdown", "x", "sad-pf"]);

// Free local regex — costs nothing on the messages that don't mention pixie,
// unlike an intent call.
function mentionsPixieByName(text) {
  return PIXIE_NAME_PATTERN.test(text || "");
}

function mentionsPixieDirectly(text) {
  const id = config.slack.botUserId;
  return !!id && (text || "").includes(`<@${id}>`);
}

function stripBotMention(text) {
  const id = config.slack.botUserId;
  if (!id) return (text || "").trim();
  return (text || "").replace(new RegExp(`<@${id}>`, "g"), "").trim();
}

function isDirectMessage(event) {
  return event.channel_type === "im";
}

/* ---------------------------------------------------------------- images -- */

function findImage(event) {
  if (!event.files?.length) return null;
  return event.files.find((f) => f.mimetype?.startsWith("image/") && f.url_private) || null;
}

async function handleImage({ event, client, imageFile }) {
  const threadTs = event.thread_ts || event.ts;
  const question = (event.text || "").trim();

  try {
    context.addToThread(threadTs, "user", `[uploaded image] ${question}`, event.user, event.channel);
    const reply = await analyzeImage(
      imageFile.url_private,
      question,
      context.getThreadContext(threadTs),
      config.slack.botToken,
    );

    if (reply) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: reply });
      context.addToThread(threadTs, "assistant", reply, null, event.channel);
      context.updateUserHistory(event.user, question || "image analysis", true);
      db.recordMetric("answer_vision");
    }
  } catch (e) {
    log.error("vision", "analysis failed:", e.message);
    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: respond.ERROR_FALLBACK });
  }
}

/* --------------------------------------------------------------- routing -- */

// Whether a thread reply in the auto-reply channel is worth an intent call.
// Previously every thread message triggered one — a 10s-timeout network call
// per message in a busy channel, with the result discarded unless it came back
// HELP_NEEDED.
function shouldConsiderThreadReply(event) {
  if (!event.thread_ts || event.thread_ts === event.ts) return true;
  if (mentionsPixieByName(event.text) || mentionsPixieDirectly(event.text)) return true;
  return context.hasSpokenInThread(event.thread_ts);
}

async function onMessage({ event, client }) {
  if (event.bot_id || event.subtype === "bot_message") return;

  const allowedSubtypes = ["file_share"];
  if (event.subtype && !allowedSubtypes.includes(event.subtype)) return;

  const threadTs = event.thread_ts || event.ts;
  const question = (event.text || "").trim();
  const isDm = isDirectMessage(event);
  const named = mentionsPixieByName(question);
  const pinged = mentionsPixieDirectly(question);

  log.debug(
    "message",
    `channel=${event.channel} dm=${isDm} thread=${event.thread_ts || "none"} ts=${event.ts} named=${named} pinged=${pinged}`,
  );

  // A human answering in a thread where pixie came up empty is the best
  // knowledge source there is. Queue it for review before any early return
  // below can skip past it — this runs regardless of whether pixie replies.
  // Not awaited: capture now ends in a model call that decides whether the reply
  // actually answers anything, and that judgement must not sit between a person
  // and pixie's reply. Fire it and let it land whenever it lands.
  if (event.thread_ts && !isDm) {
    learn
      .captureFromReply({
        threadTs: event.thread_ts,
        replyText: question,
        authorId: event.user,
        channel: event.channel,
        replyTs: event.ts,
      })
      .catch((e) => log.debug("learn", `capture failed: ${e.message}`));
  }

  const imageFile = findImage(event);
  if (imageFile) {
    // Unprompted screenshots in a busy channel aren't a question — only look
    // if pixie was addressed, or it's the help channel / a DM.
    const wanted = isDm || pinged || named || event.channel === config.slack.helpChannel;
    if (!wanted) return;
    if (!db.claimMessage(event.ts, event.channel)) return;
    await handleImage({ event, client, imageFile });
    return;
  }

  // A real @-mention is handled by the app_mention event; replying here too
  // would double-post.
  if (pinged) return;

  // DMs are private and unambiguous — always answer, full conversational mode.
  if (isDm) {
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      client,
      channel: event.channel,
      threadTs: event.thread_ts || undefined,
      userId: event.user,
      question,
      mode: respond.ALWAYS,
      seedClient: event.thread_ts ? client : null,
    });
    return;
  }

  // Plain-text "pixie ..." anywhere. Weaker signal than a real ping, so this
  // stays docs-only outside the channels pixie owns.
  if (named && event.channel !== config.slack.autoReplyChannel) {
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      mode: respond.DOCS_ONLY,
      seedClient: client,
    });
    return;
  }

  if (event.channel === config.slack.autoReplyChannel) {
    if (named) {
      if (!db.claimMessage(event.ts, event.channel)) return;
      await respond.respond({
        client,
        channel: event.channel,
        threadTs,
        userId: event.user,
        question,
        mode: respond.ALWAYS,
        seedClient: client,
      });
      return;
    }

    if (!shouldConsiderThreadReply(event)) {
      log.debug("intent", "skipping thread reply — pixie not in this thread");
      return;
    }

    if (!couldNeedHelp(question)) {
      log.debug("intent", "skipping classifier — no help signal in message");
      return;
    }

    const intent = await classifyIntent(question);
    log.debug("intent", `classified as ${intent}`);
    if (intent !== HELP_NEEDED) return;

    // Nobody addressed pixie here — the classifier just judged the message
    // worth answering. HELP_ONLY rather than ALWAYS so that if the classifier
    // was wrong, the worst case is silence instead of pixie volunteering an
    // opinion at a channel that was talking amongst itself. Small talk is for
    // people who actually pinged.
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      mode: respond.HELP_ONLY,
      seedClient: client,
    });
    return;
  }

  // Everywhere else: only top-level messages in the dedicated help channel,
  // where posting is inherently asking for help.
  if (event.thread_ts) return;
  if (event.channel === config.slack.helpChannel) {
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      mode: respond.HELP_ONLY,
    });
  }
}

async function onAppMention({ event, client }) {
  if (event.bot_id) return;
  if (!db.claimMessage(event.ts, event.channel)) return;

  await respond.respond({
    client,
    channel: event.channel,
    threadTs: event.thread_ts || event.ts,
    userId: event.user,
    question: stripBotMention(event.text),
    mode: respond.ALWAYS,
    seedClient: client,
  });
}

/* ------------------------------------------------------------- reactions -- */

async function onReactionAdded({ event, client }) {
  if (event.item.type !== "message") return;

  // Ignore reactions added by pixie itself (e.g. feedback seeding)
  if (event.user && config.slack.botUserId && event.user === config.slack.botUserId) return;

  // Only ever delete pixie's own messages. chat.delete would reject the rest
  // anyway; checking first keeps the log clean.
  if (event.reaction === DELETE_REACTION) {
    if (event.item_user && event.item_user !== config.slack.botUserId) return;
    try {
      await client.chat.delete({ channel: event.item.channel, ts: event.item.ts });
    } catch (e) {
      log.error("reaction", "failed to delete message:", e.message);
    }
    return;
  }

  // Feedback only counts on pixie's own answers.
  if (event.item_user !== config.slack.botUserId) return;
  if (UP_REACTIONS.has(event.reaction)) db.recordFeedback(event.item.ts, event.user, 1);
  else if (DOWN_REACTIONS.has(event.reaction)) db.recordFeedback(event.item.ts, event.user, -1);
}

async function onReactionRemoved({ event }) {
  if (event.item.type !== "message") return;
  if (event.item_user !== config.slack.botUserId) return;
  if (UP_REACTIONS.has(event.reaction) || DOWN_REACTIONS.has(event.reaction)) {
    db.removeFeedback(event.item.ts, event.user);
  }
}

module.exports = {
  onMessage,
  onAppMention,
  onReactionAdded,
  onReactionRemoved,
  mentionsPixieByName,
  mentionsPixieDirectly,
  stripBotMention,
  shouldConsiderThreadReply,
  couldNeedHelp,
  findImage,
};
