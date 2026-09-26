// The learning loop. Pixie can only answer from its corpus, and the corpus is
// a set of files someone has to edit and redeploy — so every question the docs
// don't cover stays uncovered forever. This closes that: helpers can teach
// pixie from inside Slack, and answers helpers give in a thread pixie missed
// get captured automatically for review.
const db = require("./db");
const cache = require("./cache");
const log = require("./log");
const programs = require("./programs");
const retrieve = require("./retrieve");
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

// Five output tokens is enough for YES/NO; anything longer is the judge
// rambling instead of judging.
const JUDGE_MAX_TOKENS = 5;
// Ten seconds: the judge must never hold up a reply path.
const JUDGE_TIMEOUT_MS = 10000;

// How many approved facts reach the corpus. Fifty Q/A pairs stay small enough
// to pass through whole while covering the long tail helpers actually teach.
const CORPUS_FACT_LIMIT = 50;

function parseTeach(text) {
  const raw = (text || "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(TEACH_SEPARATOR);
  if (idx === -1) return null;
  const question = raw.slice(0, idx).trim();
  const answer = raw.slice(idx + TEACH_SEPARATOR.length).trim();
  if (!question || !answer) return null;
  if (question.includes("\n")) return null;
  if (/^(?:Here'?s a thinking process|Thinking Process)/i.test(question)) return null;
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

// Teaching is deliberate, so it skips the queue entirely and enters active memory.
function teach({ question, answer, authorId, threadTs = null, channel = null, programId = null }) {
  const id = db.addLearnedFact({
    question,
    answer,
    authorId,
    status: APPROVED,
    sourceTs: threadTs,
    channel,
    programId,
  });
  if (id) invalidateCorpus();
  return id;
}

// Same insert path as teach(), but for the "Teach Pixie from thread" message shortcut
function captureFromThread({ question, answer, authorId, threadTs, channel, programId = null, autoApprove = false }) {
  const status = autoApprove ? APPROVED : PENDING;
  const id = db.addLearnedFact({ question, answer, authorId, status, sourceTs: threadTs, channel, programId });
  if (id && status === APPROVED) invalidateCorpus();
  return id;
}

function stripNoise(text) {
  return String(text || "")
    .replace(/<[@#!][^>]+>/g, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

function isCaptureWorthy(text) {
  const trimmed = (text || "").trim();
  if (trimmed.length < MIN_CAPTURE_LENGTH || trimmed.length > MAX_CAPTURE_LENGTH) return false;
  // A reply that's only a mention, emoji or link isn't an answer.
  return stripNoise(trimmed).length >= MIN_CAPTURE_LENGTH;
}

function judgeMessages(question, replyText) {
  return [
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
  ];
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
        onRateLimited: config.intent.onRateLimited,
        maxTokens: JUDGE_MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: JUDGE_TIMEOUT_MS,
        messages: judgeMessages(question, replyText),
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
//
// Passive thread auto-capture is hard-disabled: the 96-row junk incident proved
// shape guards cannot tell an answer from the next chat line, so learning stays
// on explicit /pixie-teach or manual approval. The unreachable history below
// was the old gap->judge->insert path; it stays deleted, not commented, so no
// future edit can re-enable it by removing one line.
async function captureFromReply(_args) {
  void _args;
  return null;
}

function pending(limit = 25, programId = null) {
  return db.listLearnedFacts(PENDING, limit, programId);
}

function approved(limit = 200, programId = null) {
  return db.listLearnedFacts(APPROVED, limit, programId);
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
function corpusSection(programId = null) {
  const facts = db.approvedFacts(CORPUS_FACT_LIMIT, programId);
  if (facts.length === 0) return "";
  return facts.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
}

// The context path never sends the whole taught section: in production it is
// unbounded (~14k chars) and used to ride outside the retrieval budget,
// crowding out the retrieved evidence it was meant to supplement. Only the
// facts sharing vocabulary with the question travel, best first, capped at
// LEARNED_MAX_FACTS whole facts within LEARNED_BUDGET chars. Program-scoped
// like corpusSection — another program's facts never rank here.
function relevantFacts(question, programId = null, { maxFacts = retrieve.LEARNED_MAX_FACTS, maxChars = retrieve.LEARNED_BUDGET } = {}) {
  const questionTokens = retrieve.tokenize(question);
  if (questionTokens.length === 0) return [];
  const scored = [];
  for (const fact of db.approvedFacts(CORPUS_FACT_LIMIT, programId)) {
    const factTokens = new Set(retrieve.tokenize(`${fact.question} ${fact.answer}`));
    let overlap = 0;
    for (const token of questionTokens) if (factTokens.has(token)) overlap += 1;
    if (overlap > 0) scored.push({ fact, overlap });
  }
  scored.sort((a, b) => {
    const overlap = b.overlap - a.overlap;
    if (overlap !== 0) return overlap;
    return (b.fact.last_supported_at || b.fact.created_at || 0) - (a.fact.last_supported_at || a.fact.created_at || 0);
  });
  // Pack whole facts so a citation never points at a severed answer; the
  // caller (retrieve.selectContext) enforces the section char cap regardless.
  const picked = [];
  let used = 0;
  for (const { fact } of scored.slice(0, maxFacts)) {
    const rendered = `Q: ${fact.question}\nA: ${fact.answer}`;
    if (picked.length > 0 && used + 2 + rendered.length > maxChars) break;
    picked.push(fact);
    used += (picked.length > 1 ? 2 : 0) + rendered.length;
  }
  return picked;
}

// Question-scoped twin of corpusSection for the context path: same Q/A shape,
// only the relevant facts. Returns "" when none match, so the section is
// omitted rather than appearing empty.
function relevantCorpusSection(question, programId = null, opts = {}) {
  const facts = relevantFacts(question, programId, opts);
  if (facts.length === 0) return "";
  return facts.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
}

function invalidateCorpusPublic() {
  invalidateCorpus();
}

module.exports = {
  parseTeach,
  teach,
  captureFromThread,
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
  relevantFacts,
  relevantCorpusSection,
  invalidateCorpus: invalidateCorpusPublic,
  PENDING,
  APPROVED,
  TEACH_SEPARATOR,
  MIN_CAPTURE_LENGTH,
  MAX_CAPTURE_LENGTH,
  MAX_CAPTURES_PER_QUESTION,
  JUDGE_MAX_TOKENS,
  JUDGE_TIMEOUT_MS,
  CORPUS_FACT_LIMIT,
};
