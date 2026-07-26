// Context awareness: track conversation threads and user history
const conversations = new Map(); // thread_ts -> { messages: [], userId: string, startedAt: timestamp }
const userHistory = new Map();   // userId -> { recentTopics: [], helpfulAnswers: [], lastSeen: timestamp }

const MAX_THREAD_MESSAGES = 20;
const THREAD_TTL = 60 * 60 * 1000; // 1 hour
const HISTORY_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function addToThread(threadTs, role, content, userId = null) {
  if (!conversations.has(threadTs)) {
    conversations.set(threadTs, {
      messages: [],
      userId,
      startedAt: Date.now(),
    });
  }

  const thread = conversations.get(threadTs);
  thread.messages.push({ role, content, timestamp: Date.now() });

  // Keep only recent messages
  if (thread.messages.length > MAX_THREAD_MESSAGES) {
    thread.messages = thread.messages.slice(-MAX_THREAD_MESSAGES);
  }
}

function getThreadContext(threadTs) {
  const thread = conversations.get(threadTs);
  if (!thread) return null;

  // Check if thread is stale
  if (Date.now() - thread.startedAt > THREAD_TTL) {
    conversations.delete(threadTs);
    return null;
  }

  return thread.messages.map(m => `${m.role}: ${m.content}`).join("\n");
}

function updateUserHistory(userId, topic, wasHelpful = true) {
  if (!userHistory.has(userId)) {
    userHistory.set(userId, {
      recentTopics: [],
      helpfulAnswers: [],
      lastSeen: Date.now(),
    });
  }

  const history = userHistory.get(userId);
  history.lastSeen = Date.now();

  if (!history.recentTopics.includes(topic)) {
    history.recentTopics.push(topic);
    if (history.recentTopics.length > 10) {
      history.recentTopics.shift();
    }
  }

  if (wasHelpful && !history.helpfulAnswers.includes(topic)) {
    history.helpfulAnswers.push(topic);
  }
}

function getUserContext(userId) {
  const history = userHistory.get(userId);
  if (!history) return null;

  // Check if history is stale
  if (Date.now() - history.lastSeen > HISTORY_TTL) {
    userHistory.delete(userId);
    return null;
  }

  return {
    recentTopics: history.recentTopics,
    helpfulAnswers: history.helpfulAnswers,
  };
}

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  
  for (const [threadTs, thread] of conversations) {
    if (now - thread.startedAt > THREAD_TTL) {
      conversations.delete(threadTs);
    }
  }

  for (const [userId, history] of userHistory) {
    if (now - history.lastSeen > HISTORY_TTL) {
      userHistory.delete(userId);
    }
  }
}, 10 * 60 * 1000);

module.exports = {
  addToThread,
  getThreadContext,
  updateUserHistory,
  getUserContext,
};
