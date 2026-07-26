require("dotenv").config();
const { App } = require("@slack/bolt");
const knowledge = require("./lib/knowledge");
const { getGroundedAnswer } = require("./lib/answer");
const { analyzeImage } = require("./lib/vision");
const context = require("./lib/context");
const guides = require("./lib/guides");
const { classifyIntent, HELP_NEEDED } = require("./lib/intent");

const MIN_QUESTION_LENGTH = 15;
const REFRESH_INTERVAL_MIN = Number(process.env.REFRESH_INTERVAL_MIN) || 30;
const MENTION_FALLBACK = "hmm not totally sure about that one — ask a helper if it's something specific :hii:";
const ERROR_FALLBACK = "having trouble thinking rn, try again in a sec :sob-pray:";
const SLACK_HELP_CHANNEL = process.env.SLACK_HELP_CHANNEL;
const FAQ_CHANNELS = (process.env.SLACK_FAQ_CHANNELS || "").split(",").map((c) => c.trim()).filter(Boolean);
const PIXL_CHANNEL = process.env.SLACK_FAQ_CHANNELS?.split(",")[0]?.trim(); // #pixl is the first FAQ channel
const PIXIE_NAME_PATTERN = /\bpixie\w*\b/i;

function mentionsPixieByName(text) {
  return PIXIE_NAME_PATTERN.test(text || "");
}

// De-dupes replies per message ts — a mention and its underlying message
// event share the same ts, and Slack can also redeliver events outright.
const answered = new Set();
function markAnswered(ts) {
  answered.add(ts);
  setTimeout(() => answered.delete(ts), 10 * 60 * 1000);
}

async function postDocAnswer(client, channel, threadTs, result) {
  let sourceLine = "";
  if (result.source) {
    const url = knowledge.getSourceUrl(result.source);
    const label = url ? `<${url}|${result.source}>` : result.source;
    sourceLine = `\n\n_from ${label} btw — lmk if this doesn't cover it and a helper will hop in_`;
  }

  const response = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: result.answer,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${result.answer}${sourceLine}` },
      },
    ],
  });

  // Add ❌ reaction for deletion
  try {
    await client.reactions.add({
      channel,
      timestamp: response.ts,
      name: "x",
    });
  } catch (e) {
    console.error("[pixie] failed to add reaction:", e.message);
  }
}

async function postChat(client, channel, threadTs, text) {
  const response = await client.chat.postMessage({ channel, thread_ts: threadTs, text });

  // Add ❌ reaction for deletion
  try {
    await client.reactions.add({
      channel,
      timestamp: response.ts,
      name: "x",
    });
  } catch (e) {
    console.error("[pixie] failed to add reaction:", e.message);
  }
}

// Fetches a grounded doc answer and posts it if found. Returns true if it
// answered, false if the docs didn't cover it. Throws on API failure so
// callers can decide fallback-vs-silence on error themselves.
async function tryDocAnswer(event, client, question, threadContext = "", userContext = null) {
  if (!question) return false;

  // Build context string for the LLM
  let contextPrompt = "";
  if (threadContext) {
    contextPrompt += `\n\nPrevious conversation:\n${threadContext}`;
  }
  if (userContext?.recentTopics?.length > 0) {
    contextPrompt += `\n\nUser has recently asked about: ${userContext.recentTopics.join(", ")}`;
  }

  const result = await getGroundedAnswer(question, knowledge.getCorpus(), contextPrompt);
  if (!result) return false;

  const threadTs = event.thread_ts || event.ts;
  await postDocAnswer(client, event.channel, threadTs, result);
  context.addToThread(threadTs, "assistant", result.answer);
  return true;
}

// Passive check: any top-level message in FAQ_CHANNELS, or a plain-text
// mention of pixie's name anywhere. Only replies if the docs actually cover
// it — stays completely silent otherwise, no forced fallback. This is a much
// weaker signal of intent than a real @-mention (people say "pixie" in
// passing, e.g. "pixie bye"), so noise here would be far more annoying.
async function handleHelpQuestion(event, client) {
  if (answered.has(event.ts)) return;
  markAnswered(event.ts);

  const question = (event.text || "").trim();
  if (question.length < MIN_QUESTION_LENGTH) return;

  const threadTs = event.thread_ts || event.ts;
  const userId = event.user;

  context.addToThread(threadTs, "user", question, userId);

  try {
    const answered = await tryDocAnswer(event, client, question);
    if (answered) {
      context.updateUserHistory(userId, question, true);
    }
  } catch (e) {
    console.error("[pixie] getGroundedAnswer failed:", e.message);
  }
}

async function handleNameMention(event, client) {
  if (answered.has(event.ts)) return;
  markAnswered(event.ts);
  console.log("[pixie/debug] handleNameMention entered for ts:", event.ts);

  const question = (event.text || "").trim();
  await respondAlways(event, client, question);
}

// Shared "always responds" flow — a grounded doc answer, a neutral fallback
// if the docs don't cover it, or an error fallback if the request itself
// failed. Never silent. Used for real @-mentions and for every top-level
// message in SLACK_HELP_CHANNEL, since every post there is a real question.
async function respondAlways(event, client, question) {
  if (!question) return;

  const threadTs = event.thread_ts || event.ts;
  const userId = event.user;

  // Track this message in the conversation context
  context.addToThread(threadTs, "user", question, userId);

  // Check if user is in an active guide
  if (guides.isInGuide(threadTs)) {
    const guideResult = guides.continueGuide(threadTs, question);
    if (guideResult) {
      const fullMessage = guideResult.checkNext
        ? `${guideResult.message}\n\n${guideResult.checkNext}`
        : guideResult.message;
      await postChat(client, event.channel, threadTs, fullMessage);
      context.addToThread(threadTs, "assistant", fullMessage);
      return;
    }
  }

  // Check if this should trigger a new guide
  const guideId = guides.detectGuideIntent(question);
  if (guideId) {
    const guideResult = guides.startGuide(guideId, threadTs, userId);
    if (guideResult) {
      const fullMessage = guideResult.checkNext
        ? `${guideResult.message}\n\n${guideResult.checkNext}`
        : guideResult.message;
      await postChat(client, event.channel, threadTs, fullMessage);
      context.addToThread(threadTs, "assistant", fullMessage);
      return;
    }
  }

  // Get conversation context for better multi-turn responses
  const threadContext = context.getThreadContext(threadTs);
  const userContext = context.getUserContext(userId);

  let answeredFromDocs;
  try {
    answeredFromDocs = await tryDocAnswer(event, client, question, threadContext, userContext);
  } catch (e) {
    console.error("[pixie] getGroundedAnswer failed:", e.message);
    await postChat(client, event.channel, threadTs, ERROR_FALLBACK);
    context.addToThread(threadTs, "assistant", ERROR_FALLBACK);
    return;
  }
  if (!answeredFromDocs) {
    await postChat(client, event.channel, threadTs, MENTION_FALLBACK);
    context.addToThread(threadTs, "assistant", MENTION_FALLBACK);
    context.updateUserHistory(userId, question, false);
  } else {
    context.updateUserHistory(userId, question, true);
  }
}

// Real @-mention: someone deliberately pinged pixie.
async function handleMention(event, client, context) {
  if (answered.has(event.ts)) return;
  markAnswered(event.ts);
  if (event.bot_id) return;

  const mentionPattern = new RegExp(`<@${context.botUserId}>`, "g");
  const question = (event.text || "").replace(mentionPattern, "").trim();
  await respondAlways(event, client, question);
}

// Every top-level message in the dedicated help channel — always answers,
// since posting there is inherently asking for help (matches the ticket flow).
async function handleHelpChannelMessage(event, client) {
  if (answered.has(event.ts)) return;
  markAnswered(event.ts);

  await respondAlways(event, client, (event.text || "").trim());
}

function startBot() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  app.event("message", async ({ event, client }) => {
    if (event.bot_id) return;

    const allowedSubtypes = ["file_share"];
    if (event.subtype && !allowedSubtypes.includes(event.subtype)) return;

    const threadTs = event.thread_ts || event.ts;
    const userId = event.user;
    const question = (event.text || "").trim();
    console.log(`[pixie/debug] message in channel ${event.channel}, PIXL_CHANNEL=${PIXL_CHANNEL}, event.thread_ts=${event.thread_ts || "none"}, event.ts=${event.ts}, isThreadReply=${event.thread_ts && event.thread_ts !== event.ts}`);

    // Handle image uploads with vision capabilities
    if (event.files && event.files.length > 0) {
      console.log("[pixie/debug] file upload detected:", event.files.length, "files");
      const imageFile = event.files.find(f => f.mimetype && f.mimetype.startsWith("image/"));
      if (imageFile && imageFile.url_private) {
        // Only analyze if: in help channel, OR explicitly mentioned/pinged
        const isMentioned = event.text && (event.text.includes(`<@${context.botUserId}>`) || mentionsPixieByName(event.text));
        const isHelpChannel = event.channel === SLACK_HELP_CHANNEL;

        if (!isMentioned && !isHelpChannel) {
          // Skip vision analysis for unprompted images
          return;
        }

        if (answered.has(event.ts)) return;
        markAnswered(event.ts);

        try {
          context.addToThread(threadTs, "user", `[uploaded image] ${question}`, userId);
          const visionResponse = await analyzeImage(
            imageFile.url_private,
            question,
            context.getThreadContext(threadTs),
            process.env.SLACK_BOT_TOKEN
          );

          if (visionResponse) {
            await postChat(client, event.channel, threadTs, visionResponse);
            context.addToThread(threadTs, "assistant", visionResponse);
            context.updateUserHistory(userId, "image analysis", true);
          }
        } catch (e) {
          console.error("[pixie] vision analysis failed:", e.message);
          await postChat(client, event.channel, threadTs, ERROR_FALLBACK);
        }
        return;
      }
    }

    if (mentionsPixieByName(event.text)) {
      console.log(`[pixie/debug] name mention detected in channel ${event.channel}, PIXL_CHANNEL=${PIXL_CHANNEL}`);
      if (event.channel === PIXL_CHANNEL) {
        await handleNameMention(event, client);
        return;
      }
    }

    if (event.thread_ts) return;

    // Intent-based auto-reply in #pixl channel (no mention required)
    if (event.channel === PIXL_CHANNEL) {
      // Skip if any bot/user is @mentioned (avoids duplicate replies when pixie is mentioned)
      if (question.includes("<@U") || question.includes("<@B")) {
        console.log(`[pixie/intent] skipping - message contains @mention`);
        return;
      }
      console.log(`[pixie/intent] checking intent for message in ${event.channel}, question: "${question}"`);
      const intent = await classifyIntent(question);
      console.log(`[pixie/intent] classified as: ${intent}`);
      if (intent === HELP_NEEDED) {
        await respondAlways(event, client, question);
      }
      return;
    }

    if (event.channel === SLACK_HELP_CHANNEL) {
      await handleHelpChannelMessage(event, client);
    }
    // FAQ_CHANNELS check removed — those channels now only respond to mentions/pings
  });

  app.event("app_mention", async ({ event, client, context }) => {
    await handleMention(event, client, context);
  });

  app.event("reaction_added", async ({ event, client }) => {
    if (event.reaction !== "x") return;
    if (event.item.type !== "message") return;
    try {
      await client.chat.delete({ channel: event.item.channel, ts: event.item.ts });
    } catch (e) {
      console.error("[pixie] failed to delete message:", e.message);
    }
  });

  knowledge
    .refreshCorpus()
    .catch((e) => console.error("[pixie] initial corpus build failed:", e.message));
  knowledge.startAutoRefresh(REFRESH_INTERVAL_MIN);

  app.start().then(() => console.log("[pixie] connected via Socket Mode"));
}

// Offline test mode: `node index.js --ask "how do i join pixl?"` builds the
// corpus and prints what pixie would reply, no Slack connection needed.
async function runAskCli(question) {
  await knowledge.refreshCorpus();

  // Check if this would trigger a guide
  const guideId = guides.detectGuideIntent(question);
  if (guideId) {
    const guideResult = guides.startGuide(guideId, "cli-test", "cli-user");
    console.log(`[pixie] would start guide: "${guideId}"`);
    console.log(`[pixie] first message: ${guideResult.message}`);
    if (guideResult.checkNext) {
      console.log(`[pixie] prompt: ${guideResult.checkNext}`);
    }
    return;
  }

  const result = await getGroundedAnswer(question, knowledge.getCorpus());
  if (!result) {
    console.log(`[pixie] would show the fallback: "${MENTION_FALLBACK}"`);
    return;
  }
  console.log(`[pixie] source: ${result.source || "(unspecified)"}`);
  console.log(`[pixie] answer: ${result.answer}`);
}

const askIdx = process.argv.indexOf("--ask");
if (askIdx !== -1) {
  const question = process.argv[askIdx + 1];
  if (!question) {
    console.error("Usage: node index.js --ask \"<question>\"");
    process.exit(1);
  }
  runAskCli(question).catch((e) => {
    console.error("[pixie] --ask failed:", e.message);
    process.exit(1);
  });
} else {
  startBot();
}
