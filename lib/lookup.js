// What pixie already knows, and how it works out what it doesn't.
//
// Split out of lib/respond.js, which decides whether and how to speak — this
// file only answers the question "what is the answer", and is the single place
// that reads and writes the answer cache.
const knowledge = require("./knowledge");
const answer = require("./answer");
const cache = require("./cache");
const program = require("./program");
const programs = require("./programs");
const link = require("./link");
const db = require("./db");
const log = require("./log");
const firecrawl = require("./firecrawl");
const shop = require("./shop");
const liveShop = require("./liveShop");

const calculator = require("./calculator");
const validator = require("./validator");
const arithmetic = require("./arithmetic");
const answerAuthorization = require("./answerAuthorization");
const { idOf, programSources } = answerAuthorization;

const DOCS_ONLY = "docs-only";

// Callers hand over whichever they have. The corpus, the answer cache and the
// timeline all key off the id; the prompt needs the whole record so it can name
// the program and its help channel. Splitting them here means neither caller
// nor answer.js has to care which form arrived.
// Single-owned in ./answerAuthorization (idOf/programSources); re-exported
// here so existing callers keep working.
function cacheHit(question, contextPrompt, programId = null) {
  if (contextPrompt) return null;
  const hit = cache.get(question, programId);
  if (!hit) return null;
  log.debug("respond", "cache hit");
  db.recordMetric("cache_hit");
  return hit;
}

// The timeline's own answer to "is it out yet" / "when's the deadline", used
// when the docs came up empty.
function dateFallback(question, contextPrompt, prog = null) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const programId = idOf(record || prog);
  const milestones = record
    ? (record.sharedSources === false ? (record.milestones || []) : (record.milestones || programs.shared().milestones))
    : programs.shared().milestones;

  const direct = program.directAnswer(question, new Date(), milestones, record);
  if (direct && !contextPrompt) cache.put(question, direct, programId);
  return direct;
}

function shopAnswer(question, prog, history = "") {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const sources = programSources(record);
  if (!sources.some((s) => s && s.type === "pixl-shop")) return null;

  const data = shop.current();
  if (!data.items.length) return null;

  const result = shop.directAnswer(question, data, { history });
  if (result) db.recordMetric("answer_shop");
  return result;
}

function liveShopAnswer(question, prog) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const sources = programSources(record);
  const source = sources.find((candidate) => candidate && candidate.type === "live-shop");
  if (!source) return null;

  const result = liveShop.directAnswer(question, liveShop.current(), source.minutesPerApprovedHour || 20);
  if (result) db.recordMetric("answer_live_shop");
  return result;
}

function calculatorAnswer(question, prog) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const sources = programSources(record);
  if (!sources.some((s) => s && s.type === "pixl-shop")) return null;

  const data = shop.current();
  const result = calculator.directAnswer(question, data);
  if (result) db.recordMetric("answer_calculator");
  return result;
}

function arithmeticAnswer(question) {
  const text = String(question || "").trim();
  const expressions = [
    text.match(/^(?:what(?:'s| is)|calculate)\s+(.+?)[?!.]?$/i)?.[1],
    text.match(/^(.+?)\s*=\s*\?$/i)?.[1],
  ].filter(Boolean);
  for (const expression of expressions) {
    try {
      const value = arithmetic.calculateMoney(expression.trim());
      return { source: "Arithmetic", direct: true, answer: `${expression.trim()} = ${value}` };
    } catch (_) {
      // This stage is intentionally narrow; unsupported expressions belong to
      // the normal answer path rather than receiving a guessed calculation.
    }
  }
  return null;
}

async function repoValidatorAnswer(question) {
  const isCheckQuery = /\b(?:check|inspect|validate|review|audit|ready for submission|submission check)\b/i.test(question);
  const parsed = validator.parseGithubUrl(question);
  if (parsed && (isCheckQuery || /^\s*https?:\/\/github\.com\/[^\s]+\s*$/i.test(question))) {
    const report = await validator.validateRepository(parsed.url);
    if (report && report.ok) {
      db.recordMetric("answer_validator");
      return {
        source: "Repo Validator",
        direct: true,
        answer: validator.formatValidationReport(report),
      };
    }
  }
  return null;
}

// WHY: one ordered chain, not two copies. lookupAnswer (docs-only) and
// answerOrChat (mention/--ask) used to paste the same five stages inline, and
// they already drifted once (validator gating). Dispatch order is load-bearing
// — code-worked answers bypass the intent gate downstream — so it lives here
// exactly once: shop, liveShop, calculator, validator, then retrieval.
async function runCodeStages(question, prog, history = "") {
  const arithmeticResult = arithmeticAnswer(question);
  if (arithmeticResult) return arithmeticResult;

  const shopped = shopAnswer(question, prog, history);
  if (shopped) return shopped;

  const liveShopped = liveShopAnswer(question, prog);
  if (liveShopped) return liveShopped;

  const calculated = calculatorAnswer(question, prog);
  if (calculated) return calculated;

  const validated = await repoValidatorAnswer(question);
  if (validated) return validated;

  return null;
}

function exactClaimAllowed(result, prog, question = "") {
  return answerAuthorization.exactClaimAllowed(result, prog, question);
}

function isMaterialPolicyQuestion(question, result) {
  return answerAuthorization.isMaterialPolicyQuestion(question, result);
}

function applyGroundingBoundary(result, prog, question = "") {
  return answerAuthorization.applyGroundingBoundary(result, prog, question);
}

function retrievalQuery(question, contextPrompt = "", prog = null) {
  let q = (question || "").trim();
  if (!contextPrompt || !contextPrompt.trim()) return q;

  const rawProgName = prog?.name || (prog?.id && prog.id !== "ysws-global" ? prog.id : "");
  const progName = /sandbox|test|staging/i.test(rawProgName) ? "" : rawProgName;

  const isFollowUp =
    /\b(it|that|this|they|them|how|what|why|steps|more|work|works|start|join|rules)\b/i.test(q) &&
    q.split(/\s+/).length <= 8;

  if (isFollowUp) {
    if (progName && !new RegExp(`\\b${progName}\\b`, "i").test(q)) {
      q = `${q} ${progName}`;
    }
    const userMatches = [...contextPrompt.matchAll(/User:\s*([^\n]+)/gi)];
    if (userMatches.length > 0) {
      const lastUserQ = userMatches[userMatches.length - 1][1].trim();
      if (lastUserQ && lastUserQ.toLowerCase() !== (question || "").trim().toLowerCase()) {
        q = `${q} ${lastUserQ}`;
      }
    }
  }

  return q;
}

async function lookupAnswer(question, contextPrompt = "", prog = null, channel = null, { isPing = false } = {}) {
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, programId);
  if (hit) return hit;

  const staged = await runCodeStages(question, prog, contextPrompt);
  if (staged) return staged;

  const query = retrievalQuery(question, contextPrompt, prog);
  const corpus = knowledge.getContext(query, programId);
  let result = await answer.getGroundedAnswer(question, corpus, contextPrompt, prog, channel, { isPing });
  if (result) {
    result = applyGroundingBoundary(result, prog, question);
  }
  if (result) {
    if (!contextPrompt) cache.put(question, result, programId);
    return result;
  }
  return dateFallback(question, contextPrompt, prog);
}

async function answerOrChat(
  question,
  contextPrompt = "",
  { onText = null, inHelpChannel = false, program: prog = null, channel = null, allowWebSearch = false, isPing = false } = {},
) {
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, programId);
  if (hit) return hit;

  const staged = await runCodeStages(question, prog, contextPrompt);
  if (staged) return staged;

  const query = retrievalQuery(question, contextPrompt, prog);
  const corpus = knowledge.getContext(query, programId);
  let result = onText
    ? await answer.getAnswerOrChatStream(question, corpus, contextPrompt, { onText, inHelpChannel, program: prog, channel, isPing })
    : await answer.getAnswerOrChat(question, corpus, contextPrompt, inHelpChannel, prog, channel, { isPing });

  if (!result?.source) {
    const direct = dateFallback(question, contextPrompt, prog);
    if (direct) return direct;

    result = await webFallback({ question, contextPrompt, corpus, prog, channel, isPing, inHelpChannel, allowWebSearch }) || result;
  }

  result = applyGroundingBoundary(result, prog, question);
  if (result?.source && !contextPrompt) cache.put(question, result, programId);
  return result;
}

// WHY: Firecrawl leaves the box only here. lookupAnswer is the docs-only path
// (slash commands, cached flows) — letting it hit the web would bill network
// research to callers that promised a corpus answer and would poison the
// answer cache with unreviewed web text. answerOrChat-only, and only when the
// caller explicitly allows it (pings).
async function webFallback({ question, contextPrompt, corpus, prog, channel, isPing, inHelpChannel, allowWebSearch }) {
  if (!allowWebSearch) return null;
  const webResults = await firecrawl.searchWeb(question).catch(() => null);
  if (!webResults || webResults.length === 0) return null;
  const webSnippet = webResults
    .map((r) => `Title: ${r.title}\nURL: ${r.url}\n${r.markdown}`)
    .join("\n\n");
  const webContextPrompt = `${contextPrompt}\n\n=== WEB RESEARCH ===\n${webSnippet}`;
  return answer
    .getGroundedAnswer(question, corpus, webContextPrompt, prog, channel, { isPing, inHelpChannel })
    .catch(() => null);
}

function knownAnswer({ question, contextPrompt, mode, program: prog = null }) {
  if (contextPrompt) return null;
  if (link.extractUrl(question)) return null;
  if (mode === DOCS_ONLY) return null;
  return cacheHit(question, contextPrompt, idOf(prog));
}

module.exports = {
  idOf,
  cacheHit,
  shopAnswer,
  liveShopAnswer,
  dateFallback,
  retrievalQuery,
  lookupAnswer,
  answerOrChat,
  knownAnswer,
  arithmeticAnswer,
  exactClaimAllowed,
  applyGroundingBoundary,
};
