// The gate: does this person want an answer, or are they just talking?
//
// This used to be a pile of regexes — question words, problem words, banter
// markers, word counts — with a model call behind them as a second opinion.
// The regexes were wrong in both directions constantly: "still broken lol" is a
// joke or a cry for help depending entirely on what the person said five
// minutes ago, and no pattern over a single message can tell those apart.
//
// So the judgement is the model's, and it gets the one thing that actually
// disambiguates: the last few messages from the same person. What survives here
// is a noise filter (emoji, reactions, one-word replies) whose only job is to
// avoid paying for a model call on a message that plainly says nothing.
//
// Kept as a separate call rather than folded into the answer prompt — that was
// tried and measured, and 6 of 15 genuine questions went silent.
const { config } = require("./config");
const { complete } = require("./llm");
const { looksLikeCode } = require("./answer");
const db = require("./db");
const programs = require("./programs");
const log = require("./log");

const MAX_TOKENS = 20;
const MIN_LENGTH = 5;
const TIMEOUT_MS = 10000;
const HELP_NEEDED = "HELP_NEEDED";
const CASUAL_CHAT = "CASUAL_CHAT";
// Only ever returned for a program whose scope is "program", and only when
// nobody addressed pixie: a real question, put to the room, about something
// that isn't this program. Someone will help — it just isn't her job here.
const OFF_TOPIC = "OFF_TOPIC";

// How many of the person's own previous messages the gate is shown. Three is
// enough to see what someone is in the middle of; past that the prompt grows
// and the verdict doesn't move.
const HISTORY_LIMIT = 3;

function intentSystemPrompt(program = null, { scoped = false } = {}) {
  const name = typeof program === "string" ? program : program?.name || "Hack Club YSWS";

  // Answering general coding questions in a channel that only wants program
  // answers is the same failure as answering banter: a reply nobody asked for.
  // So it is the same call, made by the same model, in the same breath.
  const scopeRule = scoped
    ? `

There is a third verdict here, because this channel only wants ${name} answers from pixie.

Answer OFF_TOPIC when someone genuinely needs help, but with something that is NOT about ${name} — general programming, a library or framework, their own unrelated project, maths, hardware, life advice, another Hack Club program. Real question, wrong bot. A human in the channel will take it.

Use HELP_NEEDED only when the thing they are stuck on is ${name} itself, or the things ${name} requires of them: signing up, submitting, deadlines, rules, prizes, the ${name} tooling and setup, or getting their ${name} project to the point where it counts.

If you cannot tell whether a question is about ${name} or not, answer OFF_TOPIC. Staying out of it is free.`
    : "";

  return `You are the gate for pixie, a Slack bot in the ${name} channels at Hack Club. Pixie replies only when someone is actually waiting on an answer, and says nothing at all otherwise.

You are shown the last few messages from one person, then the ONE message you have to judge. The earlier messages are context only — never judge them. Judge the final message.

The single question you are answering is: **is this person waiting for an answer or for help, right now?**

Answer HELP_NEEDED when:
- they are asking something and expect a reply${scoped ? "" : " — about " + name + ", their project, code, tooling (git, github, hackatime), setup, deadlines, or how something works"}
- they are reporting something broken, failing, stuck or unexpected, with or without a question mark
- they are choosing between options and want input
- their earlier messages show them working a problem and this one continues it ("still nothing", "same error", "ok that didnt work") — mid-debug, that IS a request
- they were just given an answer and are following up on it ("wait how do i do that", "where is that setting")

Answer CASUAL_CHAT when:
- thinking out loud, riffing, hypotheticals ("what if i just used 60 api keys", "imagine if...")
- jokes, hype, reactions, greetings, thanks, agreement, "gg", "lets go"
- narrating what they're doing or about to do ("gonna rewrite this in rust")
- opinions, complaints or rants with no request in them
- rhetorical questions, or a question clearly aimed at one named person rather than the room
- their earlier messages were banter and this one is more of the same
- they already got their answer and this is acknowledgement

Do not decide on topic. Almost everything in these channels is technical. Riffing about a build system is still riffing; "my build broke" with no question mark is still a request. The test is whether somebody is waiting.

Do not decide on shape either. A question mark does not make it a request, and its absence does not make it chat. Use the person's recent messages to work out which one this is.${scopeRule}

Reply with EXACTLY one word: ${scoped ? "HELP_NEEDED, CASUAL_CHAT or OFF_TOPIC" : "HELP_NEEDED or CASUAL_CHAT"}.

When you genuinely cannot tell, choose CASUAL_CHAT. A missed question costs nothing — a human answers it. A reply nobody asked for is noise in the channel.`;
}

// The person's own recent messages, oldest first, plus the message to judge.
// Kept as one user turn rather than a fake multi-turn transcript so the model
// can't mistake the history for instructions addressed to it.
function buildUserPrompt(message, history = []) {
  const lines = [];

  if (history.length > 0) {
    lines.push(`Their previous ${history.length} message(s), oldest first:`);
    history.forEach((h, i) => lines.push(`${i + 1}. ${h}`));
  } else {
    lines.push("They have not said anything recently — no context available.");
  }

  lines.push("", "The message to judge:", message);
  return lines.join("\n");
}

function historyFor(userId, channel, current) {
  if (!userId) return [];
  try {
    const rows = db
      .recentUserMessages(userId, { channel, limit: HISTORY_LIMIT + 1 })
      .map((r) => (r.text || "").trim())
      .filter(Boolean);

    // lib/handlers.js records a message the moment it arrives, so the newest
    // row is usually the very message being judged. Drop exactly one copy.
    if (rows.length > 0 && current && rows[rows.length - 1] === current.trim()) rows.pop();

    return rows.slice(-HISTORY_LIMIT);
  } catch (e) {
    log.debug("intent", `history lookup failed: ${e.message}`);
    return [];
  }
}

// `addressed` is the escape hatch on scope: somebody said pixie's name and put
// a question to her, so whether it is "about the program" stops being the
// question. She answers.
function scopedFor(program, addressed = false) {
  return !addressed && programs.isProgramScoped(program);
}

async function classifyIntent(
  message,
  program = null,
  { userId = null, channel = null, history = null, addressed = false } = {},
) {
  if (!message || message.length < MIN_LENGTH) return CASUAL_CHAT;

  const scoped = scopedFor(program, addressed);
  const recent = history || historyFor(userId, channel, message);

  try {
    const { text } = await complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: MAX_TOKENS,
        temperature: 0.3,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: intentSystemPrompt(program, { scoped }) },
          { role: "user", content: buildUserPrompt(message, recent) },
        ],
      },
      "intent",
    );

    const trimmed = text?.trim();
    if (trimmed?.startsWith(HELP_NEEDED)) return HELP_NEEDED;
    if (trimmed?.startsWith(CASUAL_CHAT)) return CASUAL_CHAT;
    // Never offered unless scoped, but a model that volunteers it anyway is
    // making a judgement pixie should honour rather than discard.
    if (trimmed?.startsWith(OFF_TOPIC)) return OFF_TOPIC;
    return null;
  } catch (e) {
    log.error("intent", "classification failed:", e.message);
    return null;
  }
}

/* ----------------------------------------------------------- noise filter -- */

// Whole messages that are pure reaction. Matched exactly, after emoji, pings
// and punctuation are stripped — so "w" is dropped and "w gate or not?" is not.
// This is deliberately not a judgement about meaning; it exists so a channel
// full of "lmao" doesn't cost a model call each.
const REACTION_ONLY = new Set(
  ("lol lmao lmfao lmaoo lmaooo rofl haha hahaha hehe ok okay okey k kk yeah yea ye yep yup nah nope no yes" +
    " same fr frfr ngl bruh bro yo hi hey hello sup wsg gm gn ty thx thanks tysm np gg ggs w l true real" +
    " nice cool sick based goated damn oof rip wow yay lets go letsgo bet sheesh finally done exactly this")
    .split(" "),
);

// Slack decoration, not words: emoji shortcodes, user/channel pings, bare links.
function stripDecoration(text) {
  return (text || "")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .replace(/<[@#!][^>]+>/g, " ")
    .replace(/<https?:\/\/[^>]+>/gi, " ")
    .trim();
}

function normalizeReaction(text) {
  return stripDecoration(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Is this message worth asking the model about at all? The answer is yes for
// anything with words in it. Only emoji-only messages, empty messages and
// bare reactions are dropped — no guess is made about what the words mean.
function worthClassifying(text) {
  const raw = (text || "").trim();
  if (!raw) return false;
  if (looksLikeCode(raw)) return true;

  const stripped = stripDecoration(raw);
  if (stripped.length < MIN_LENGTH) return false;

  const normalized = normalizeReaction(raw);
  if (!normalized) return false;
  if (REACTION_ONLY.has(normalized)) return false;
  // "lmao same", "yeah true" — every word is a reaction word.
  const words = normalized.split(" ");
  if (words.length <= 3 && words.every((w) => REACTION_ONLY.has(w))) return false;

  return true;
}

/* --------------------------------------------------------- gap heuristics -- */

// Still a regex, and deliberately: this does not decide whether pixie speaks.
// It decides whether a missed question is written to the docs to-do list and
// whether an offer to walk someone through a guide is made — a false positive
// there costs a row in a table, not a message in the channel. The gate's
// verdict is preferred wherever one exists (see lib/respond.js).
const PROBLEM_WORD =
  /\b(?:broke|broken|breaks|breaking|error|errors|fail(?:s|ed|ing)?|stuck|bug|bugged|issue|crash(?:ed|ing|es)?|glitch\w*|not working|no idea|confused)\b/i;

const BROKEN_VERB =
  /\b(?:wont|won't|cant|can't|doesnt|doesn't|isnt|isn't|didnt|didn't|not)\s+(?:\w+\s+){0,2}(?:work|works|working|load|loads|loading|run|runs|running|build|building|open|opening|start|starting|render|rendering|show|showing|display|appear|appearing|find|connect|connecting|compile|compiling|save|saving|export|launch|install|update|sync|respond|responding|recognize|detect)\b/i;

const ASK_SHAPE =
  /\?|\b(?:how|what|where|why|which|when|who)\b[^.!?]{0,30}\b(?:do|does|did|can|should|would|is|are|to)\b|\b(?:should|can|could|do) i\b|\banyone know\b|\bdoes anyone\b|\bis there a way\b|\bhow to\b|\bhelp\b/i;

const MIN_REQUEST_WORDS = 3;

function wordCount(text) {
  return text.split(/\s+/).length;
}

function looksLikeHelpRequest(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (looksLikeCode(t)) return true;
  if (wordCount(t) < MIN_REQUEST_WORDS) return false;
  return PROBLEM_WORD.test(t) || BROKEN_VERB.test(t) || ASK_SHAPE.test(t);
}

module.exports = {
  classifyIntent,
  intentSystemPrompt,
  buildUserPrompt,
  scopedFor,
  worthClassifying,
  looksLikeHelpRequest,
  HISTORY_LIMIT,
  HELP_NEEDED,
  CASUAL_CHAT,
  OFF_TOPIC,
};
