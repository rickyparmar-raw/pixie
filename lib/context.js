// Conversation context — thread transcripts and per-user topic history.
// Storage is SQLite (lib/db.js) so context survives a restart; this module is
// the interface everything else uses.
const db = require("./db");
const log = require("./log");

// Pixie only ever saw the messages it was invoked on, so a question like
// "wait so how does that work?" had no referent. Seeding from the real Slack
// thread once fixes that.
const SEED_LIMIT = 30;
const INTENT_CONTEXT_LIMIT = 8;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 4000;
const transientThreads = new Map();

function threadRows(threadTs) {
  return transientThreads.get(threadTs) || [];
}

function addToThread(threadTs, role, content, userId = null, channel = null) {
  if (!threadTs) return;
  const rows = threadRows(threadTs);
  rows.push({ role, content, user_id: userId });
  if (rows.length > MAX_CONTEXT_MESSAGES * 3) rows.splice(0, rows.length - MAX_CONTEXT_MESSAGES * 3);
  transientThreads.set(threadTs, rows);
  db.touchThread(threadTs, channel, { pixieSpoke: role === "assistant" });
}

function contextTokens(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function overlap(left, right) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function selectContextMessages(messages, currentQuestion = null) {
  const questionAlreadyStored = currentQuestion && messages.at(-1)?.role === "user"
    && messages.at(-1).content === currentQuestion;
  const candidates = currentQuestion && !questionAlreadyStored
    ? [...messages, { role: "user", content: currentQuestion }]
    : messages;
  if (candidates.length <= MAX_CONTEXT_MESSAGES) return candidates;

  const latestQuestionIndex = [...candidates]
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user")
    .at(-1)?.index;
  const question = currentQuestion || candidates[latestQuestionIndex]?.content || "";
  const questionTokens = contextTokens(question);
  const selected = new Set();

  if (latestQuestionIndex !== undefined) {
    selected.add(latestQuestionIndex);
    if (latestQuestionIndex > 0 && messages[latestQuestionIndex - 1].role === "assistant") {
      selected.add(latestQuestionIndex - 1);
    }
  }

  const ranked = candidates
    .map((message, index) => ({
      index,
      score: overlap(contextTokens(message.content), questionTokens) * 10 + index / messages.length,
    }))
    .filter(({ index }) => !selected.has(index))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_CONTEXT_MESSAGES);

  for (const { index } of ranked) {
    if (selected.size >= MAX_CONTEXT_MESSAGES) break;
    const adjacentAssistant = candidates[index].role === "user"
      ? [index - 1, index + 1].find((neighbor) => candidates[neighbor]?.role === "assistant")
      : undefined;
    if (selected.size + (adjacentAssistant !== undefined && !selected.has(adjacentAssistant) ? 2 : 1) > MAX_CONTEXT_MESSAGES) continue;
    selected.add(index);
    if (adjacentAssistant !== undefined) {
      selected.add(adjacentAssistant);
    }
  }

  return [...selected]
    .sort((left, right) => left - right)
    .reduce((result, index) => {
      const message = candidates[index];
      const rendered = `${message.role}: ${message.content}`;
      const currentLength = result.reduce((length, item) => length + item.rendered.length + 1, 0);
      if (currentLength + rendered.length <= MAX_CONTEXT_CHARS || result.length === 0) {
        result.push({ message, rendered });
      }
      return result;
    }, [])
    .map(({ message }) => message);
}

function getThreadContext(threadTs, currentQuestion = null) {
  const messages = threadRows(threadTs);
  if (messages.length === 0) return null;
  return selectContextMessages(messages, currentQuestion)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

function getThreadMessages(threadTs, limit = 8) {
  if (!threadTs) return [];
  return threadRows(threadTs)
    .slice(-limit)
    .map((message) => ({
      text: message.content,
      speaker: message.role === "assistant" ? "pixie" : "human",
    }));
}

// Pure so the seeding loop stays a straight line: the bot's own messages (by
// user id or bot_id) read back as assistant, everything else as user.
function roleForMessage(message, botUserId) {
  return message.user === botUserId || message.bot_id ? "assistant" : "user";
}

// True once pixie has replied in this thread — used to decide whether a thread
// reply is worth an intent call at all.
function hasSpokenInThread(threadTs) {
  return !!db.getThread(threadTs)?.pixie_spoke;
}

// Pulls the real Slack thread the first time pixie touches it, so it can
// answer questions that refer to what humans said above. Runs once per thread
// (the `seeded` flag), and failure is non-fatal — worst case pixie has the
// context it would have had anyway.
//
// `currentTs` is the message pixie is answering right now. It gets skipped: on
// a top-level mention the thread ts IS that message, so seeding would copy the
// question into the transcript before it is answered — which reads back as
// "previous conversation" and disables the answer cache for every fresh
// question. respond() adds it to the transcript itself, in the right order.
async function seedFromSlack(client, channel, threadTs, botUserId, currentTs = null) {
  const existing = db.getThread(threadTs);
  if (existing?.seeded) return;

  db.touchThread(threadTs, channel, { seeded: true });

  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: SEED_LIMIT });
    const messages = res.messages || [];
    for (const m of messages) {
      if (currentTs && m.ts === currentTs) continue;
      const text = (m.text || "").trim();
      if (!text) continue;
       addToThread(threadTs, roleForMessage(m, botUserId), text, m.user || null, channel);
    }
    log.debug("context", `seeded thread ${threadTs} with ${messages.length} messages`);
  } catch (e) {
    log.debug("context", `could not seed thread ${threadTs}: ${e.message}`);
  }
}

async function recentChannelMessages(client, channel, latestTs, botUserId, limit = INTENT_CONTEXT_LIMIT) {
  if (!client?.conversations?.history || !channel) return [];
  try {
    const result = await client.conversations.history({
      channel,
      latest: latestTs,
      inclusive: false,
      limit,
    });
    return (result.messages || [])
      .reverse()
      .map((message) => ({
        text: (message.text || "").trim(),
        speaker: roleForMessage(message, botUserId) === "assistant" ? "pixie" : "human",
        userId: message.user || null,
      }))
      .filter((message) => message.text);
  } catch (e) {
    log.debug("context", `could not fetch recent channel context: ${e.message}`);
    return [];
  }
}

// Previously the raw question text was stored as the "topic", and up to ten of
// them were pasted verbatim into every system prompt. Reduce to keywords so
// the injected context stays a few words per entry instead of a few sentences.
const STOPWORDS = new Set(
  ("a an the is are was were do does did how what when where why who which can could should would will i you my me" +
    " to of in on for with and or but if it its this that these those get got have has had am be been im ive dont" +
    " cant whats hows pls plz help there here about from any some so just like need want know")
    .split(" "),
);

const MAX_TOPIC_WORDS = 5;

function deriveTopic(question) {
  const words = (question || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  const topic = [...new Set(words)].slice(0, MAX_TOPIC_WORDS).join(" ");
  return topic || (question || "").slice(0, 40).trim();
}

function updateUserHistory(userId, question, wasHelpful = true) {
  const topic = deriveTopic(question);
  if (topic) db.recordTopic(userId, topic, wasHelpful);
}

function getUserContext(userId) {
  const rows = db.getTopics(userId);
  if (rows.length === 0) return null;
  return {
    recentTopics: rows.map((r) => r.topic),
    helpfulAnswers: rows.filter((r) => r.was_helpful).map((r) => r.topic),
  };
}

module.exports = {
  addToThread,
  getThreadContext,
  getThreadMessages,
  hasSpokenInThread,
  seedFromSlack,
  recentChannelMessages,
  updateUserHistory,
  getUserContext,
  deriveTopic,
};
