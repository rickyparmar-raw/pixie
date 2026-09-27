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

function threadRows(threadTs: any) {
  return transientThreads.get(threadTs) || [];
}

function addToThread(threadTs: any, role: any, content: any, userId: any = null, channel: any = null) {
  if (!threadTs) return;
  const rows = threadRows(threadTs);
  rows.push({ role, content, user_id: userId });
  if (rows.length > MAX_CONTEXT_MESSAGES * 3) rows.splice(0, rows.length - MAX_CONTEXT_MESSAGES * 3);
  transientThreads.set(threadTs, rows);
  db.touchThread(threadTs, channel, { pixieSpoke: role === "assistant" });
}

function contextTokens(text: any) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word: any) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function overlap(left: any, right: any) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function selectContextMessages(messages: any, currentQuestion: any = null) {
  const questionAlreadyStored = currentQuestion && messages.at(-1)?.role === "user"
    && messages.at(-1).content === currentQuestion;
  const candidates = currentQuestion && !questionAlreadyStored
    ? [...messages, { role: "user", content: currentQuestion }]
    : messages;
  if (candidates.length <= MAX_CONTEXT_MESSAGES) return candidates;

  const latestQuestionIndex = [...candidates]
    .map((message: any, index: any) => ({ message, index }))
    .filter(({ message }: any) => message.role === "user")
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
    .map((message: any, index: any) => ({
      index,
      score: overlap(contextTokens(message.content), questionTokens) * 10 + index / messages.length,
    }))
    .filter(({ index }: any) => !selected.has(index))
    .sort((left: any, right: any) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_CONTEXT_MESSAGES);

  for (const { index } of ranked) {
    if (selected.size >= MAX_CONTEXT_MESSAGES) break;
    const adjacentAssistant = candidates[index].role === "user"
      ? [index - 1, index + 1].find((neighbor: any) => candidates[neighbor]?.role === "assistant")
      : undefined;
    if (selected.size + (adjacentAssistant !== undefined && !selected.has(adjacentAssistant) ? 2 : 1) > MAX_CONTEXT_MESSAGES) continue;
    selected.add(index);
    if (adjacentAssistant !== undefined) {
      selected.add(adjacentAssistant);
    }
  }

  return ([...selected] as any[])
    .sort((left: any, right: any) => left - right)
    .reduce((result: any, index: any) => {
      const message = candidates[index];
      const rendered = `${message.role}: ${message.content}`;
      const currentLength = result.reduce((length: any, item: any) => length + item.rendered.length + 1, 0);
      if (currentLength + rendered.length <= MAX_CONTEXT_CHARS || result.length === 0) {
        result.push({ message, rendered });
      }
      return result;
    }, [])
    .map(({ message }: any) => message);
}

function getThreadContext(threadTs: any, currentQuestion: any = null) {
  const messages = threadRows(threadTs);
  if (messages.length === 0) return null;
  return selectContextMessages(messages, currentQuestion)
    .map((m: any) => `${m.role}: ${m.content}`)
    .join("\n");
}

function getThreadMessages(threadTs: any, limit: any = 8) {
  if (!threadTs) return [];
  return threadRows(threadTs)
    .slice(-limit)
    .map((message: any) => ({
      text: message.content,
      speaker: message.role === "assistant" ? "pixie" : "human",
    }));
}

// Pure so the seeding loop stays a straight line: the bot's own messages (by
// user id or bot_id) read back as assistant, everything else as user.
function roleForMessage(message: any, botUserId: any) {
  return message.user === botUserId || message.bot_id ? "assistant" : "user";
}

// True once pixie has replied in this thread — used to decide whether a thread
// reply is worth an intent call at all.
function hasSpokenInThread(threadTs: any) {
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
async function seedFromSlack(client: any, channel: any, threadTs: any, botUserId: any, currentTs: any = null) {
  const existing = db.getThread(threadTs);
  // The seeded flag is persistent but the transcript is in memory, so after a
  // restart a seeded thread has no context at all: seed it again.
  if (existing?.seeded && threadRows(threadTs).length) return;

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
  } catch (e: any) {
    log.debug("context", `could not seed thread ${threadTs}: ${e.message}`);
  }
}

// Who is in a thread besides the current sender. Pixie follows a thread on
// her own only while it is just her and one person; once anyone else has
// posted, the humans are talking and she waits to be called.
function threadCrowd(messages: any, userId: any, botUserId: any) {
  let pixieIn = false;
  let othersPresent = false;
  for (const m of messages) {
    if (roleForMessage(m, botUserId) === "assistant") pixieIn = true;
    else if (m.user && m.user !== userId) othersPresent = true;
  }
  return { pixieIn, othersPresent };
}

const CROWD_CHECK_LIMIT = 200;

// Reads the real thread from Slack. If that fails, the thread's starter
// (parent_user_id) is the only evidence left: someone else started it means
// someone else is in it. Without the thread we cannot confirm it is just
// Pixie and this person, so pixieIn stays false and nothing is upgraded to
// addressed.
async function fetchThreadCrowd(client: any, { channel, threadTs, messageTs, userId, botUserId, parentUserId = null }: any) {
  const fallback = {
    pixieIn: false,
    othersPresent: Boolean(parentUserId && parentUserId !== userId && parentUserId !== botUserId),
  };
  if (!client?.conversations?.replies || !threadTs || !messageTs) return fallback;
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: CROWD_CHECK_LIMIT });
    const before = (res.messages || []).filter((m: any) => Number(m.ts) < Number(messageTs));
    return threadCrowd(before, userId, botUserId);
  } catch (e: any) {
    log.debug("context", `thread crowd check failed: ${e.message}`);
    return fallback;
  }
}

async function recentChannelMessages(client: any, channel: any, latestTs: any, botUserId: any, limit: any = INTENT_CONTEXT_LIMIT) {
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
      .map((message: any) => ({
        text: (message.text || "").trim(),
        speaker: roleForMessage(message, botUserId) === "assistant" ? "pixie" : "human",
        userId: message.user || null,
      }))
      .filter((message: any) => message.text);
  } catch (e: any) {
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

function deriveTopic(question: any) {
  const words = (question || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w: any) => w.length > 2 && !STOPWORDS.has(w));

  const topic = [...new Set(words)].slice(0, MAX_TOPIC_WORDS).join(" ");
  return topic || (question || "").slice(0, 40).trim();
}

function updateUserHistory(userId: any, question: any, wasHelpful: any = true) {
  const topic = deriveTopic(question);
  if (topic) db.recordTopic(userId, topic, wasHelpful);
}

function getUserContext(userId: any) {
  const rows = db.getTopics(userId);
  if (rows.length === 0) return null;
  return {
    recentTopics: rows.map((r: any) => r.topic),
    helpfulAnswers: rows.filter((r: any) => r.was_helpful).map((r: any) => r.topic),
  };
}

export = {
  addToThread,
  getThreadContext,
  getThreadMessages,
  hasSpokenInThread,
  seedFromSlack,
  recentChannelMessages,
  threadCrowd,
  fetchThreadCrowd,
  updateUserHistory,
  getUserContext,
  deriveTopic,
};
