// Bounded conversation context for the support pipeline.
//
// Previously assembled inline in lib/respond.js. Moved here unchanged so the
// context contract — what the classifier and the model get to see — has one
// owner and one test target. Behavior is frozen:
//
// - thread transcript only (never user history) for doc lookups, so the
//   answer cache keeps working;
// - per-user topics injected ONLY for explicit recall questions, so the
//   mention path stays cacheable;
// - newest/current message preserved exactly, never summarized;
// - bounded to MAX_CONTEXT_MESSAGES / MAX_CONTEXT_CHARS via lib/context.js;
// - programs never mix: the transcript is one thread's, and retrieval stays
//   program-scoped downstream;
// - bot chatter never dominates: selection is relevance-ranked around the
//   current question in lib/context.js.
const context = require("./context");
const db = require("./db");

function buildContextPrompt(threadContext) {
  return threadContext ? `\n\nPrevious conversation:\n${threadContext}` : "";
}

const RECALL_PATTERN =
  /\b(?:remember|remembered|recall|forgot|forget|previously|earlier|last time)\b|\bwhat\b[^?.!]{0,20}\bi\b[^?.!]{0,20}\bask/i;

function isRecallQuestion(text) {
  return RECALL_PATTERN.test(text || "");
}

function buildChatContext(threadContext, userContext, question = "") {
  const parts = [buildContextPrompt(threadContext)];
  if (!isRecallQuestion(question)) return parts.join("");

  const topics = userContext?.recentTopics || [];
  if (topics.length > 0) {
    parts.push(
      `\n\nThis is your memory of what this person has asked you recently, newest first: ${topics.join("; ")}.` +
        " If they ask what they asked before, or what you remember about them, answer from this list.",
    );
  } else {
    parts.push(
      "\n\nYou have no record of this person asking you anything before." +
        " If they ask what they asked previously, say you don't have anything for them yet — do not invent a history.",
    );
  }

  return parts.join("");
}

// Bare referential messages ("this", "above", "^", "what about that") carry
// no subject of their own, so the pipeline answers the most recent real user
// question from the thread instead. Anything with its own subject — including
// "what about software?" — keeps its own text; subject inheritance for those
// happens in lookup.retrievalQuery, not here.
const REFERENTIAL_QUERY = /^(?:\^+|above|see above|this|what about (?:this|that)|answer this|look above)\s*$/i;

function resolveEffectiveQuestion(trimmed, threadTs) {
  let effectiveQuestion = trimmed;
  if (REFERENTIAL_QUERY.test(trimmed) && threadTs) {
    const messages = db.getThreadMessages(threadTs);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "user" && m.content && !REFERENTIAL_QUERY.test(m.content.trim())) {
        effectiveQuestion = m.content.trim();
        break;
      }
    }
  }
  return effectiveQuestion;
}

module.exports = {
  RECALL_PATTERN,
  buildContextPrompt,
  buildChatContext,
  isRecallQuestion,
  REFERENTIAL_QUERY,
  resolveEffectiveQuestion,
};
