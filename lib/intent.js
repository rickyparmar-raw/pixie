// The gate for the auto-reply channel: does this message want an answer, or is
// it chat? A separate model call that never sees the corpus, plus the free
// local pre-filters that run before it.
//
// Kept separate ON PURPOSE. Folding it into the answer call was tried and
// measured: with 6k characters of documentation in the same context the model
// collapses "nobody asked" into "the docs don't cover it", and 6 of 15 genuine
// questions came back silent across three trials — "how do i submit my project"
// in two of them. lib/respond.js runs this call CONCURRENTLY with the answer
// instead, which buys the same ~1700ms without touching this prompt.
const { config } = require("./config");
const { complete } = require("./llm");
const { looksLikeCode } = require("./answer");
const { QUESTION_WORD } = require("./chat");
const log = require("./log");

const MAX_TOKENS = 20; // minimal tokens for binary classification
const MIN_LENGTH = 5;
const TIMEOUT_MS = 10000;
const HELP_NEEDED = "HELP_NEEDED";
const CASUAL_CHAT = "CASUAL_CHAT";

// The question this prompt asks is "did this person ask for help?", NOT "is this
// message about a technical topic". The topic-first version this replaced called
// "wait WHAT IF I JS GET 60 DIFFERENT API KEYS AND KEEP ON USING ROUND ROBIN"
// HELP_NEEDED — coding-shaped, so it matched, even though nobody asked pixie
// anything. In a channel where people think out loud all day, topic relevance is
// nearly always true and therefore carries almost no signal; whether someone is
// stuck and waiting on an answer is the thing that actually decides it.
function intentSystemPrompt() {
  return `You are the gate for pixie, a Slack bot in a busy channel about Pixl (a game/program for Hack Clubbers). Pixie speaks only when someone actually wants an answer, and stays quiet for everything else.

Decide whether this message is a genuine request for help or information.

HELP_NEEDED — this person is stuck or waiting on an answer:
- a real question about Pixl, coding, their project, technical setup (git, github, hackatime), or math
- something broken, failing or stuck, even with no question mark ("my build broke", "sprite wont load")
- asking how to do something, or which of two options to pick

CASUAL_CHAT — everything else, including:
- hypotheticals and ideas said out loud ("what if i just used 60 api keys", "imagine if we...") — that's riffing, not asking
- jokes, hype, reactions, greetings, thanks, agreement
- saying what they're doing or about to do ("gonna rewrite this in rust")
- opinions, complaints and rants where nothing is being asked
- rhetorical questions that don't want an answer
- a question aimed at one specific person rather than the room
- questions unrelated to Pixl, coding or math

The test is not whether the topic is technical — most messages here are. The test is whether someone is waiting on an answer.

Reply with EXACTLY one word: HELP_NEEDED or CASUAL_CHAT.

Be strict: when in doubt, choose CASUAL_CHAT. A missed question costs nothing — a human will answer it. An unwanted reply is noise in the channel.`;
}

// Returns HELP_NEEDED, CASUAL_CHAT, or null when the call itself failed.
// Callers treat null as "don't reply" — an outage should make pixie quiet, not
// chatty.
async function classifyIntent(message) {
  if (!message || message.length < MIN_LENGTH) return CASUAL_CHAT;

  try {
    const { text } = await complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        maxTokens: MAX_TOKENS,
        temperature: 0.3,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: intentSystemPrompt() },
          { role: "user", content: message },
        ],
      },
      "intent",
    );

    // Model may pad the label with extra text — match on the prefix.
    const trimmed = text?.trim();
    if (trimmed?.startsWith(HELP_NEEDED)) return HELP_NEEDED;
    if (trimmed?.startsWith(CASUAL_CHAT)) return CASUAL_CHAT;
    return null;
  } catch (e) {
    log.error("intent", "classification failed:", e.message);
    return null;
  }
}

/* ------------------------------------------------------- local pre-filters -- */
// Both of these run before (and instead of) the network call above. They live
// here rather than in handlers.js so lib/respond.js can use them too without
// the two modules requiring each other.

// Not every message deserves a classifier call. The log said 322 of 343 intent
// classifications came back CASUAL_CHAT — 94% of a ~1.5s network call, thrown
// away, and on a free tier each one eats rate-limit budget that real questions
// then queue behind. It matters more now that the classifier runs alongside the
// answer call: everything this filter drops is a pair of calls not made.
//
// Deliberately a NEGATIVE filter: it only skips what obviously isn't a help
// request, and anything uncertain still pays for the call. The problem words
// matter as much as the question words — "my build broke" is a genuine
// HELP_NEEDED with neither a question mark nor a question word, and a
// question-shape-only filter would silently drop it.
const PROBLEM_WORD =
  /\b(?:broke|broken|breaks|breaking|error|errors|fail(?:s|ed|ing)?|stuck|bug|bugged|issue|crash(?:ed|ing|es)?|glitch\w*|not working|no idea|confused)\b/i;

// Too weak to let pixie speak on its own ("thats weird lol" is a reaction, not a
// report), but plenty to justify paying for a classifier call. Loose path only.
const SOFT_PROBLEM = /\b(?:weird|janky|scuffed|glitchy)\b/i;

// A negative contraction only reports a problem when something is failing to
// *do* something. Bare, it is ordinary conversational negation, and the old list
// treated every one of them as a help signal. That is how "ridit isn't" — two
// words, someone hitting enter early mid-sentence — cleared both gates and got
// answered with "sorry, what about ridit? could you clarify what you mean?" in a
// thread where nobody had addressed pixie.
const BROKEN_VERB =
  /\b(?:wont|won't|cant|can't|doesnt|doesn't|isnt|isn't|didnt|didn't|not)\s+(?:\w+\s+){0,2}(?:work|works|working|load|loads|loading|run|runs|running|build|building|open|opening|start|starting|render|rendering|show|showing|display|appear|appearing|find|connect|connecting|compile|compiling|save|saving|export|launch|install|update|sync|respond|responding|recognize|detect)\b/i;

const MIN_WORDS_WITHOUT_SIGNAL = 4;

// Nothing under this is a request being put to the room, whatever words it
// happens to contain — it's a fragment, an aside, or half a sentence.
const MIN_REQUEST_WORDS = 3;

function hasProblemSignal(text) {
  return PROBLEM_WORD.test(text) || BROKEN_VERB.test(text);
}

function wordCount(text) {
  return text.split(/\s+/).length;
}

// Thinking out loud is not asking. People riff in this channel constantly —
// "wait WHAT IF I JS GET 60 DIFFERENT API KEYS AND KEEP ON USING ROUND ROBIN"
// carries a question word and enough length to look like a request, and pixie
// answered it with an opinion nobody wanted. These markers only ever get
// consulted after the positive signals have all missed, so a real question that
// happens to contain one ("what if my build breaks?" — has both a question mark
// and a problem word) never reaches them.
const BANTER =
  /\bwhat if\b|\bimagine\b|\bwould'?nt it be\b|\bwe should\b|\bplot twist\b|\bhear me out\b|\blmao?\b|\blmfao\b|\blol+\b|\bngl\b|\bbruh\b|\bfr fr\b|\bgoated\b/i;

// Someone actively putting a request to the room. Stricter than couldNeedHelp:
// that one decides whether a classifier call is worth paying for, this one
// decides whether pixie may speak at all when nobody addressed it.
const ASK_SHAPE =
  /\?|\b(?:how|what|where|why|which|when|who)\b[^.!?]{0,30}\b(?:do|does|did|can|should|would|is|are|to)\b|\b(?:should|can|could|do) i\b|\banyone know\b|\bdoes anyone\b|\bis there a way\b|\bhow to\b|\bhelp\b/i;

function couldNeedHelp(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.includes("?") || looksLikeCode(t) || hasProblemSignal(t) || SOFT_PROBLEM.test(t)) return true;
  if (BANTER.test(t)) return false;
  if (QUESTION_WORD.test(t)) return true;
  // No signal at all. A longer message may still be someone describing a
  // problem in plain statements, so only the short ones are safe to skip.
  return wordCount(t) >= MIN_WORDS_WITHOUT_SIGNAL;
}

// Gate for HELP_ONLY mode: is this message actually asking the room for
// something? Small talk fails it, which is the point — pixie chats back only
// when it was addressed, never at a channel that was talking amongst itself.
function looksLikeHelpRequest(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (looksLikeCode(t)) return true;
  // A fragment is not a request. Code is exempt above — a pasted stack trace is
  // short on words and still obviously someone stuck.
  if (wordCount(t) < MIN_REQUEST_WORDS) return false;
  return hasProblemSignal(t) || ASK_SHAPE.test(t);
}

module.exports = {
  classifyIntent,
  intentSystemPrompt,
  couldNeedHelp,
  looksLikeHelpRequest,
  HELP_NEEDED,
  CASUAL_CHAT,
};
