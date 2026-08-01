// The learning loop. Pixie can only answer from its corpus, and the corpus is
// a set of files someone has to edit and redeploy — so every question the docs
// don't cover stays uncovered forever. This closes that: helpers can teach
// pixie from inside Slack, and answers helpers give in a thread pixie missed
// get captured automatically for review.
const db = require("./db");
const cache = require("./cache");
const log = require("./log");
const { config } = require("./config");
// Module object, not a destructured `complete`: destructuring binds at load time
// and makes the call impossible to stub, which forces every test through the
// live API. Same reason lib/respond.js holds ./answer this way.
const llm = require("./llm");

const PENDING = "pending";
const APPROVED = "approved";

// `/pixie-teach <question> :: <answer>`
const TEACH_SEPARATOR = "::";

// Auto-capture guards. A reply has to look like an actual answer, not "lol" or
// "same" — junk in the corpus is worse than a gap, because it gets stated with
// the same confidence as the real docs.
const MIN_CAPTURE_LENGTH = 25;
const MAX_CAPTURE_LENGTH = 1500;
const MAX_CAPTURES_PER_QUESTION = 2;

const JUDGE_MAX_TOKENS = 5;
const JUDGE_TIMEOUT_MS = 10000;

function parseTeach(text) {
  const raw = (text || "").trim();
  if (!raw) return null;

  const idx = raw.indexOf(TEACH_SEPARATOR);
  if (idx === -1) return null;

  const question = raw.slice(0, idx).trim();
  const answer = raw.slice(idx + TEACH_SEPARATOR.length).trim();
  if (!question || !answer) return null;

  return { question, answer };
}

// Changing what pixie knows has to drop two caches, not one: the per-question
// answer cache, and the memoised corpus string in knowledge.js. Missing the
// second would leave a newly approved fact out of the corpus until the next
// scheduled refresh. Required lazily so learn and knowledge don't form a
// load-time cycle — knowledge.js pulls this module the same way.
function invalidateCorpus() {
  cache.clearCache();
  require("./knowledge").invalidate();
}

// Teaching is deliberate, so it skips the queue entirely.
function teach({ question, answer, authorId }) {
  const id = db.addLearnedFact({ question, answer, authorId, status: APPROVED });
  if (id) invalidateCorpus();
  return id;
}

function isCaptureWorthy(text) {
  const trimmed = (text || "").trim();
  if (trimmed.length < MIN_CAPTURE_LENGTH || trimmed.length > MAX_CAPTURE_LENGTH) return false;
  // A reply that's only a mention, emoji or link isn't an answer.
  const withoutNoise = trimmed
    .replace(/<[@#!][^>]+>/g, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  return withoutNoise.length >= MIN_CAPTURE_LENGTH;
}

// The guards above are all shape checks — length, noise, who wrote it. None of
// them can tell whether the text answers anything, and that is exactly what went
// wrong: 96 captured rows where the "answer" was just the next thing said in the
// thread. "pixie whats my slack id" filed under an answer of "pixie say my name,"
// passes every cheap guard there is.
//
// So ask. Fails closed — a network error or an unparseable reply means no
// capture, because a wrong fact in the corpus is stated with the same confidence
// as the real docs, while a missed capture costs nothing but a second chance.
async function judgeAnswer(question, replyText) {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        maxTokens: JUDGE_MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: JUDGE_TIMEOUT_MS,
        messages: [
          {
            role: "system",
            content:
              "You check whether a Slack message answers a question. Reply with EXACTLY one word: YES or NO.\n\n" +
              "YES only when the message gives the asker information that resolves their question — a fix, an " +
              "explanation, a link with context, a direct factual reply.\n\n" +
              "NO for everything else: someone continuing the conversation, asking their own question, " +
              "reacting, joking, agreeing, guessing, or talking about something unrelated. Most messages in a " +
              "thread are NO.\n\n" +
              "When in doubt, answer NO.",
          },
          { role: "user", content: `Question: ${question}\n\nMessage: ${replyText}` },
        ],
      },
      "learn",
    );
    return text?.trim().toUpperCase().startsWith("YES") === true;
  } catch (e) {
    log.debug("learn", `capture judge failed: ${e.message}`);
    return false;
  }
}

// Called for every human reply in a thread. Captures only when the thread's
// parent is a question pixie recorded a miss on, and only once per reply.
// Returns the new row id, or null when nothing was captured.
//
// Async because of the judge call, and deliberately not awaited by its caller —
// this is bookkeeping and must never sit between a person and their reply.
async function captureFromReply({ threadTs, replyText, authorId, channel, replyTs }) {
  if (!threadTs || threadTs === replyTs) return null;
  if (!isCaptureWorthy(replyText)) return null;

  // #pixl is a chat channel: threads there are people talking, not people being
  // answered, and that is where the junk captures came from. The help channel is
  // the only place a reply is likely to be an answer at all.
  if (!config.slack.helpChannel || channel !== config.slack.helpChannel) return null;

  // Stops the same reply being captured twice on a redelivered event.
  if (replyTs && db.hasCapturedSource(replyTs)) return null;

  const gap = db.gapForThread(threadTs);
  if (!gap) return null;

  // Don't capture the asker answering themselves — usually "nvm figured it out"
  // rather than an answer anyone else can use.
  if (gap.user_id && gap.user_id === authorId) return null;

  // A thread is a conversation, not an answer. The first one or two substantive
  // replies are the candidate; reply fifteen is people talking.
  if (db.pendingCountForQuestion(gap.question) >= MAX_CAPTURES_PER_QUESTION) return null;

  // Last, because it's the only guard that costs a network call.
  if (!(await judgeAnswer(gap.question, replyText.trim()))) {
    log.debug("learn", `judge rejected a candidate for: ${gap.question.slice(0, 60)}`);
    return null;
  }

  const id = db.addLearnedFact({
    question: gap.question,
    answer: replyText.trim(),
    authorId,
    status: PENDING,
    sourceTs: replyTs,
    channel,
  });

  if (id) log.info("learn", `captured a candidate answer for: ${gap.question.slice(0, 60)}`);
  return id;
}

function pending(limit = 25) {
  return db.listLearnedFacts(PENDING, limit);
}

function approved(limit = 200) {
  return db.listLearnedFacts(APPROVED, limit);
}

function approve(id) {
  const ok = db.setLearnedStatus(id, APPROVED);
  // Without this the answer cache keeps serving the pre-learning reply.
  if (ok) invalidateCorpus();
  return ok;
}

function forget(id) {
  const ok = db.deleteLearnedFact(id);
  if (ok) invalidateCorpus();
  return ok;
}

function forgetByStatus(status) {
  const count = db.deleteLearnedByStatus(status);
  if (count > 0) invalidateCorpus();
  return count;
}

function forgetRange(fromId, toId) {
  const count = db.deleteLearnedRange(fromId, toId);
  if (count > 0) invalidateCorpus();
  return count;
}

// Rendered into the corpus in the same Q/A shape textFromJsonFaq() produces,
// so the answer prompt needs no special handling and can cite it like any
// other source. Returns "" when nothing is approved, so the section is omitted
// rather than appearing empty.
function corpusSection() {
  const facts = db.approvedFacts();
  if (facts.length === 0) return "";
  return facts.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
}

module.exports = {
  parseTeach,
  teach,
  captureFromReply,
  judgeAnswer,
  isCaptureWorthy,
  pending,
  approved,
  approve,
  forget,
  forgetByStatus,
  forgetRange,
  corpusSection,
  PENDING,
  APPROVED,
  TEACH_SEPARATOR,
  MIN_CAPTURE_LENGTH,
  MAX_CAPTURES_PER_QUESTION,
};
