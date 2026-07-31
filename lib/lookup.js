// What pixie already knows, and how it works out what it doesn't.
//
// Split out of lib/respond.js, which decides whether and how to speak — this
// file only answers the question "what is the answer", and is the single place
// that reads and writes the answer cache.
const knowledge = require("./knowledge");
// Module object rather than destructured, so the model call can be stubbed —
// see the note in lib/respond.js.
const answer = require("./answer");
const cache = require("./cache");
const program = require("./program");
const link = require("./link");
const db = require("./db");
const log = require("./log");

const DOCS_ONLY = "docs-only";

// Cached lookups are only valid when nothing conversation-specific went into
// the prompt — otherwise two people would share an answer shaped by one
// person's thread.
function cacheHit(question, contextPrompt) {
  if (contextPrompt) return null;
  const hit = cache.get(question);
  if (!hit) return null;
  log.debug("respond", "cache hit");
  db.recordMetric("cache_hit");
  return hit;
}

// Safety net for date questions the model intermittently declines. Only fires
// after it has already said no, so a natural grounded answer is still
// preferred — this just stops a known-exact fact falling through to the
// ungrounded path, where it gets guessed at instead.
function dateFallback(question, contextPrompt) {
  const direct = program.directAnswer(question);
  if (direct && !contextPrompt) cache.put(question, direct);
  return direct;
}

// Strict corpus lookup: an answer or nothing. Used by DOCS_ONLY mode, where
// silence is the correct outcome for a miss, and by the --ask CLI.
async function lookupAnswer(question, contextPrompt) {
  const hit = cacheHit(question, contextPrompt);
  if (hit) return hit;

  const result = await answer.getGroundedAnswer(question, knowledge.getContext(question), contextPrompt);
  if (result) {
    if (!contextPrompt) cache.put(question, result);
    return result;
  }
  return dateFallback(question, contextPrompt);
}

// The ALWAYS-mode lookup: one model call that either answers from the docs
// (`source` set) or replies conversationally (`source` null). Replaces the
// grounded-call-then-chat-call pair, which cost two round-trips — ~2.3s of the
// measured 5.6s on the path most traffic takes.
//
// `gate` adds the "was anyone actually asking?" judgement to the same call, for
// messages nobody addressed to pixie — see answerOrChatPrompt. `onText` streams
// the answer out as it is written; without it the call behaves exactly as
// before and returns only when the completion is finished.
async function answerOrChat(question, contextPrompt, { onText = null } = {}) {
  const hit = cacheHit(question, contextPrompt);
  if (hit) return hit;

  const corpus = knowledge.getContext(question);
  const result = onText
    ? await answer.getAnswerOrChatStream(question, corpus, contextPrompt, { onText })
    : await answer.getAnswerOrChat(question, corpus, contextPrompt);

  // No source means the docs didn't cover it — including for timing questions,
  // which this model declines maybe a third of the time regardless of how the
  // prompt insists otherwise. The deterministic answer wins over a chat reply
  // that would be guessing.
  if (!result?.source) {
    const direct = dateFallback(question, contextPrompt);
    if (direct) return direct;
  }

  if (result?.source && !contextPrompt) cache.put(question, result);
  return result;
}

// Is this a question pixie can answer without thinking about it?
//
// Deliberately narrow. A conversation-specific prompt was never cacheable, and a
// pasted link has to be read before anything is said about it — the page content
// joins contextPrompt *after* this point, so a cached answer here would reply
// about the question while ignoring the link entirely.
function knownAnswer({ question, contextPrompt, mode }) {
  if (contextPrompt) return null;
  if (link.extractUrl(question)) return null;
  // DOCS_ONLY has no placeholder to save and takes its own path through
  // lookupAnswer, which does the same lookup.
  if (mode === DOCS_ONLY) return null;
  return cacheHit(question, contextPrompt);
}


module.exports = {
  cacheHit,
  dateFallback,
  lookupAnswer,
  answerOrChat,
  knownAnswer,
};
