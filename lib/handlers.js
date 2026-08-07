// Slack event routing. Decides *whether* pixie should speak; lib/respond.js
// decides what it says.
const { config } = require("./config");
const vision = require("./vision");
const { couldNeedHelp } = require("./intent");
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
// unlike a model call.
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
  // Reached from onAppMention as well as onMessage, so the raw text can carry a
  // literal "<@U0BKJ...>" — which the vision model would read as part of the
  // question rather than as the addressing it is.
  const question = stripBotMention(event.text);

  try {
    context.addToThread(threadTs, "user", `[uploaded image] ${question}`, event.user, event.channel);
    const reply = await vision.analyzeImage(
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

// Whether a thread reply in the auto-reply channel is worth looking at at all.
// Previously every thread message triggered a model call — one network round
// trip per message in a busy channel, with the result discarded unless it said
// someone needed help.
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
      messageTs: event.ts,
      mode: respond.ALWAYS,
      seedClient: event.thread_ts ? client : null,
    });
    return;
  }

  // Plain-text "pixie ..." anywhere. Weaker signal than a real ping, so this
  // stays docs-only outside the channels pixie owns. The help channel has its
  // own naming rules below (ALWAYS, and it's what lets a thread reply back in
  // at all), so it's excluded here rather than being caught by this first.
  if (named && event.channel !== config.slack.autoReplyChannel && event.channel !== config.slack.helpChannel) {
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      messageTs: event.ts,
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
        messageTs: event.ts,
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
      log.debug("intent", "skipping model call — no help signal in message");
      db.recordMetric("silent", null, "not_a_question");
      return;
    }

    // The intent classifier used to run to completion right here, ~1700ms in
    // front of everything else. HELP_ONLY now starts it inside respond(),
    // alongside the answer call rather than before it — nothing is posted until
    // it agrees someone was asking, so the judgement is unchanged and only the
    // waiting is gone.
    //
    // HELP_ONLY rather than ALWAYS for the same reason as before: if the
    // classifier is wrong, the worst case is silence instead of pixie
    // volunteering an opinion at a channel that was talking amongst itself.
    // Small talk is for people who actually pinged.
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      messageTs: event.ts,
      mode: respond.HELP_ONLY,
      seedClient: client,
    });
    return;
  }

  // Everywhere else: the dedicated help channel, where posting is inherently
  // asking for help.
  if (event.channel !== config.slack.helpChannel) return;

  // Top-level posts always qualify — one reply per question asked. Thread
  // replies are different: once pixie has answered, staying quiet unless
  // named or pinged again is the point, not a gap to route around. This used
  // to also fire on any thread pixie had ever spoken in, gated only by a
  // "could this need help" heuristic loose enough to pass most follow-ups —
  // which meant pixie answered nearly every message in a thread it had
  // touched once, real conversation or not. A real ping is handled by
  // onAppMention (see the early `if (pinged) return` above), so `named` is
  // the only signal left to check here.
  if (event.thread_ts && !named) {
    log.debug("intent", "skipping help thread reply — pixie not named or pinged");
    db.recordMetric("silent", null, "not_named");
    return;
  }

  if (!db.claimMessage(event.ts, event.channel)) return;
  await respond.respond({
    client,
    channel: event.channel,
    threadTs,
    userId: event.user,
    question,
    messageTs: event.ts,
    mode: respond.ALWAYS,
    seedClient: event.thread_ts ? client : null,
  });
}

async function onAppMention({ event, client }) {
  if (event.bot_id) return;
  if (!db.claimMessage(event.ts, event.channel)) return;

  // Slack delivers BOTH `message` and `app_mention` for "@pixie <screenshot>",
  // and both handlers claim the same event.ts — so whichever one Slack sends
  // first decides the reply. Only onMessage looked for an image, so when
  // app_mention won the race pixie answered a screenshot with "I can't actually
  // see images", while the identical post without an @-mention got analysed
  // fine. Handling images in both paths makes the race stop mattering.
  const imageFile = findImage(event);
  if (imageFile) {
    await handleImage({ event, client, imageFile });
    return;
  }

  await respond.respond({
    client,
    channel: event.channel,
    threadTs: event.thread_ts || event.ts,
    userId: event.user,
    question: stripBotMention(event.text),
    messageTs: event.ts,
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
