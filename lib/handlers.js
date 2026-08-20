// Slack event routing. Decides *whether* pixie should speak; lib/respond.js
// decides what it says.
const { config } = require("./config");
const vision = require("./vision");
const { worthClassifying } = require("./intent");
const context = require("./context");
const respond = require("./respond");
const guides = require("./guides");
const learn = require("./learn");
const db = require("./db");
const log = require("./log");
const programs = require("./programs");

const PIXIE_NAME_PATTERN = /\bpixie\w*\b/i;
const DELETE_REACTION = "pixl-delete";
const UP_REACTIONS = new Set(["yay", "thumbs-up", "+1", "yesyes", "white_check_mark", "heavy_check_mark", "upvote", "sparkling_heart", "heart", "heart_eyes"]);
const DOWN_REACTIONS = new Set(["nono", "-1", "thumbsdown", "x", "sad-pf"]);
const GUIDE_ADVANCE_REACTION = "upvote";

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

  const prog = programs.forChannel(event.channel);
  const inHelpChannel = programs.isHelpChannel(event.channel);
  const isPassive = prog.posture === "passive";

  // Recorded for every human message, including the ones pixie says nothing
  // about — the gate judges a message against what this person said just
  // before it, and most of that is in messages pixie never replied to.
  if (question) {
    db.recordUserMessage({ userId: event.user, channel: event.channel, threadTs, text: question });
  }

  log.debug(
    "message",
    `channel=${event.channel} dm=${isDm} thread=${event.thread_ts || "none"} ts=${event.ts} named=${named} pinged=${pinged} prog=${prog.id} posture=${prog.posture}`,
  );

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
    const wanted = isDm || pinged || named || inHelpChannel;
    if (!wanted) return;
    if (!db.claimMessage(event.ts, event.channel)) return;
    await handleImage({ event, client, imageFile });
    return;
  }

  if (pinged) return;

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

  const isProgChannel = (prog.channels && prog.channels.includes(event.channel)) || config.slack.faqChannels.includes(event.channel);

  if (named && !inHelpChannel && !isProgChannel) {
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

  if (isProgChannel && !inHelpChannel) {
    if (named) {
      if (!db.claimMessage(event.ts, event.channel)) return;
      await respond.respond({
        client,
        channel: event.channel,
        threadTs,
        userId: event.user,
        question,
        messageTs: event.ts,
        mode: isPassive ? respond.HELP_ONLY : respond.ALWAYS,
        seedClient: client,
        // They said her name and asked. A program scoped to its own questions
        // doesn't get to refuse that — see lib/intent.js.
        addressed: true,
      });
      return;
    }

    if (!shouldConsiderThreadReply(event)) {
      log.debug("intent", "skipping thread reply — pixie not in this thread");
      return;
    }

    if (!worthClassifying(question)) {
      log.debug("intent", "skipping model call — nothing but emoji or a bare reaction");
      context.addToThread(threadTs, "user", question, event.user, event.channel);
      db.recordMetric("silent", null, "no_content");
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
      mode: respond.HELP_ONLY,
      seedClient: client,
    });
    return;
  }

  if (!inHelpChannel) return;

  if (event.thread_ts && !named) {
    log.debug("intent", "skipping help thread reply — pixie not named or pinged");
    if (context.hasSpokenInThread(event.thread_ts)) {
      context.addToThread(threadTs, "user", question, event.user, event.channel);
    }
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
    mode: isPassive ? respond.HELP_ONLY : respond.ALWAYS,
    seedClient: event.thread_ts ? client : null,
    addressed: named,
  });
}

async function onAppMention({ event, client }) {
  const question = stripBotMention(event.text);
  const threadTs = event.thread_ts || event.ts;

  const imageFile = findImage(event);
  if (imageFile) {
    if (!db.claimMessage(event.ts, event.channel)) return;
    await handleImage({ event, client, imageFile });
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
    seedClient: client,
  });
}

async function onReactionAdded({ event, client }) {
  // A reaction_added event carries the channel on event.item, not on the event
  // itself. Reading event.channel made every call below run with an undefined
  // channel; Slack's error was caught and logged at debug, so :pixl-delete:
  // failed silently and the guide step was posted into nowhere.
  const channel = event.item?.channel || event.channel;

  if (event.reaction === DELETE_REACTION) {
    try {
      const msg = await client.conversations.history({
        channel,
        latest: event.item.ts,
        limit: 1,
        inclusive: true,
      });

      if (msg.messages?.[0]?.user === config.slack.botUserId) {
        await client.chat.delete({ channel, ts: event.item.ts });
        log.info("handlers", `deleted message ${event.item.ts} via reaction`);
      }
    } catch (e) {
      log.debug("handlers", `could not delete message: ${e.message}`);
    }
    return;
  }

  const normReaction = (event.reaction || "").toLowerCase();

  if (normReaction === GUIDE_ADVANCE_REACTION) {
    try {
      const guideState = db.getGuideByMessageTs(event.item.ts) || db.getGuide(event.item.ts);
      const nextStepResult = await guides.advanceGuideByReaction({
        messageTs: event.item.ts,
        userId: event.user,
      });
      if (nextStepResult !== null && guideState) {
        const stepText = typeof nextStepResult === "string" ? nextStepResult : nextStepResult.message;
        const stepTs = await client.chat.postMessage({
          channel,
          thread_ts: guideState.thread_ts,
          text: stepText,
        });
        await db.setGuideMessageTs(guideState.thread_ts, stepTs.ts);
        log.info("guides", `advanced guide via reaction in thread ${guideState.thread_ts}`);
        return;
      }
    } catch (e) {
      log.debug("guides", `reaction advance failed: ${e.message}`);
    }
  }

  const vote = UP_REACTIONS.has(normReaction) ? 1 : DOWN_REACTIONS.has(normReaction) ? -1 : 0;
  if (vote !== 0) {
    db.recordFeedback(event.item.ts, event.user, vote);
    log.info("feedback", `vote=${vote} ts=${event.item.ts} user=${event.user}`);
  }
}

async function onReactionRemoved({ event }) {
  const normReaction = (event.reaction || "").toLowerCase();
  if (UP_REACTIONS.has(normReaction) || DOWN_REACTIONS.has(normReaction)) {
    db.removeFeedback(event.item.ts, event.user);
  }
}

module.exports = {
  onMessage,
  onAppMention,
  onReactionAdded,
  onReactionRemoved,
  shouldConsiderThreadReply,
  mentionsPixieByName,
  mentionsPixieDirectly,
  stripBotMention,
  findImage,
  handleImage,
};
