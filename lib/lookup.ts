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
const grounding = require("./grounding");

const DOCS_ONLY = "docs-only";

// Callers hand over whichever they have. The corpus, the answer cache and the
// timeline all key off the id; the prompt needs the whole record so it can name
// the program and its help channel. Splitting them here means neither caller
// nor answer.js has to care which form arrived.
function idOf(program: any) {
  if (!program) return null;
  return typeof program === "string" ? program : program.id || null;
}

function cacheScope(program: any) {
  const id = idOf(program);
  return id;
}

function programSources(record: any) {
  record = typeof record === "string" ? programs.get(record) : record;
  const shared = record && record.sharedSources === false ? [] : (programs.shared().sources || []);
  return [...(record?.sources || []), ...shared];
}

function cacheHit(question: any, contextPrompt: any, programId: any = null, skipCache: any = false) {
  if (contextPrompt || skipCache) return null;
  const hit = cache.get(question, programId);
  if (!hit) return null;
  log.debug("respond", "cache hit");
  db.recordMetric("cache_hit");
  return hit;
}

function dateFallback(question: any, contextPrompt: any, prog: any = null) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const programId = idOf(record || prog);
  const milestones = record
    ? (record.sharedSources === false ? (record.milestones || []) : (record.milestones || programs.shared().milestones))
    : programs.shared().milestones;

  // No canned "no end date announced" answer here: a program's docs (Pixl's
  // knowledge base states its end date) must decide that, not a template
  // that fired on any question containing "end" and claimed "4 months".
  const direct = program.directAnswer(question, new Date(), milestones, record);
  if (direct && !contextPrompt) cache.put(question, direct, programId);
  return direct;
}

function shopAnswer(question: any, prog: any, history: any = "") {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const sources = programSources(record);
  if (!sources.some((s: any) => s && s.type === "pixl-shop")) return null;

  const data = shop.current();
  if (!data.items.length) return null;

  const result = shop.directAnswer(question, data, { history });
  if (result) db.recordMetric("answer_shop");
  return result;
}

function liveShopAnswer(question: any, prog: any) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const sources = programSources(record);
  const source = sources.find((candidate: any) => candidate && candidate.type === "live-shop");
  if (!source) return null;

  const result = liveShop.directAnswer(question, liveShop.current(), source.minutesPerApprovedHour || 20);
  if (result) db.recordMetric("answer_live_shop");
  return result;
}

function liveKnowledgeAnswer(question: any, prog: any) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  if (record?.id !== "live-ysws") return null;
  const text = String(question || "");
  const source = "Live YSWS Pixie Knowledge Base";
  if (/approved hour/i.test(text) && /(?:add|adds|give|gives|multiplier|stream|time)/i.test(text)) {
    return { source, answer: "Each approved hour adds 10 minutes to the Live YSWS stream." };
  }
  if (/multiple.*lapse|lapse.*multiple/i.test(text)) {
    return { source, answer: "Yes, you can include multiple Lapse links in one submission, separated by commas." };
  }
  if (/fully.*cad|cad.*hardware/i.test(text) && /allowed|submit|project/i.test(text)) {
    return { source, answer: "Yes, fully CAD hardware projects are allowed in Live YSWS when they meet the submission requirements." };
  }
  return null;
}

function calculatorAnswer(question: any, prog: any) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const sources = programSources(record);
  if (!sources.some((s: any) => s && s.type === "pixl-shop")) return null;

  const data = shop.current();
  const result = calculator.directAnswer(question, data);
  if (result) db.recordMetric("answer_calculator");
  return result;
}

function arithmeticAnswer(question: any) {
  const text = String(question || "").trim();
  const expressions: string[] = [
    text.match(/^(?:what(?:'s| is)|calculate)\s+(.+?)[?!.]?$/i)?.[1],
    text.match(/^(.+?)\s*=\s*\?$/i)?.[1],
  ].filter((expression): expression is string => Boolean(expression));
  for (const expression of expressions) {
    try {
      const value = arithmetic.calculateMoney(expression.trim());
      return { source: "Arithmetic", direct: true, answer: `${expression.trim()} = ${value}` };
    } catch (_: any) {
      // This stage is intentionally narrow; unsupported expressions belong to
      // the normal answer path rather than receiving a guessed calculation.
    }
  }
  return null;
}

async function repoValidatorAnswer(question: any) {
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
async function runCodeStages(question: any, prog: any, history: any = "") {
  const arithmeticResult = arithmeticAnswer(question);
  if (arithmeticResult) return arithmeticResult;

  const shopped = shopAnswer(question, prog, history);
  if (shopped) return shopped;

  const liveShopped = liveShopAnswer(question, prog);
  if (liveShopped) return liveShopped;

  const liveKnowledge = liveKnowledgeAnswer(question, prog);
  if (liveKnowledge) return liveKnowledge;

  const calculated = calculatorAnswer(question, prog);
  if (calculated) return calculated;

  const validated = await repoValidatorAnswer(question);
  if (validated) return validated;

  return null;
}

// Topics where Pixie must never freestyle — only a matched, current, owned
// source can authorize an exact answer. This is the code-level backstop for
// the "authoritative-only" classes: review mechanics/timing/queue/outcome,
// hour/eligibility edge cases, AI policy and enforcement, and money/
// fulfillment specifics. Each is a class the corpus itself (see the
// do-not-hallucinate list in PIXL_PIXIE_KNOWLEDGE_BASE.md) already warns
// against inventing — this enforces it even when a model ignores the prompt.
const AUTHORITATIVE_ONLY_RES = [
  // REVIEW: mechanics, timing, queue, reviewer state, outcome prediction.
  /\b(?:first|second|third|1st|2nd|3rd)\s+pass\b/i,
  /\bfraud\s*review\b/i,
  /\breview\w*\s+(?:queue|status|state)\b/i,
  /\breview\w*\b[^.!?\n]{0,40}\b(?:how\s+long|eta|timing|take|takes|taking|taken|duration|when|available|availability|waiting|wait|pending|stuck|slow)\b/i,
  /\b(?:how\s+long|eta|when)\b[^.!?\n]{0,25}\breview\w*\b/i,
  /\bwhy\b[^.!?\n]{0,40}\b(?:review\w*|approved|passed|waiting|pending|stuck)\b/i,
  /\bwill\s+(?:my|this|it|the\s+project)\b[^.!?\n]{0,25}\b(?:pass|fail|get\s+(?:approved|rejected))\b/i,
  /\bdeflat\w*\b/i,
  // ELIGIBILITY / HOURS: does an activity count, edge cases in logging it.
  /\bcount(?:s|ed|ing)?\s+(?:as|toward|towards|for|into)\b/i,
  /\b(?:does|do|is|are|would|will)\b[^.!?\n]{0,40}\bcount\b/i,
  /\b(?:research|learning|tutorial)\s+time\b/i,
  /\buncommitted\b[^.!?\n]{0,20}\bsession/i,
  /\bwhat\s+evidence\b/i,
  /\bhand[- ]?drawn\b|\bhandwritten\b/i,
  // AI / ENFORCEMENT
  /\bai\s+(?:limit|percentage|cap|allowance|policy)\b/i,
  /\bhow\s+much\s+ai\b/i,
  /\bfraud\b/i,
  /\b(?:banned?|appeal\w*|penalt\w*|violat\w*)\b/i,
  // MONEY / FULFILLMENT: exact timing, amounts, individual order state.
  /\bpayout\w*\b[^.!?\n]{0,25}\b(?:when|how\s+much|exact|amount|timing)\b/i,
  /\b(?:when|how\s+long)\b[^.!?\n]{0,25}\bpayout\w*\b/i,
  /\bshipping\s+(?:time|eta|when|status)\b/i,
  /\bwhen\b[^.!?\n]{0,20}\b(?:ship|shipped|arrive|arrives)\b/i,
  /\bcustoms\b/i,
  /\bgrant\w*\b[^.!?\n]{0,25}\b(?:status|when|amount)\b/i,
  /\border\s+status\b|\btracking\s+number\b/i,
  // Legacy broad policy vocabulary — kept alongside the above rather than
  // replaced, so nothing this already protected regresses.
  /\b(?:policy|rule|rules|eligible|eligibility|allowed|prohibited|forbidden|tax|expense|locally)\b/i,
];

function isAuthoritativeOnlyTopic(question: any, result: any) {
  if (result?.direct) return false;
  const text = String(question || "");
  return AUTHORITATIVE_ONLY_RES.some((re: any) => re.test(text));
}

// Digit-bearing claims with a unit attached — "14 days", "80%", "$50",
// "6 hours" — are exactly the shape of thing PIXL_PIXIE_KNOWLEDGE_BASE.md's
// do-not-hallucinate list warns about (SLA, queue position, AI percentage,
// payout amount). Bare digits with no unit ("step 3") are left alone; they
// are not the hallucination risk this exists to catch, and flagging them
// would reject far more real answers than fabricated ones.
// "%" is split into its own alternative because it is not a word character —
// a trailing \b right after it never matches (no boundary between two
// non-word characters), which would silently make every percentage claim
// invisible to this guard.
const NUMERIC_CLAIM_RE = /\$\s?\d[\d,.]*|\b\d[\d,.]*\s?%|\b\d[\d,.]*\s?(?:percent|px|pixels?|hours?|hrs?|days?|weeks?|months?|dollars?)\b/gi;

function normalizeForMatch(text: any) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ");
}

// A number in the answer is only real if the same digits, with the same
// unit, actually appear somewhere in what was retrieved. No corpus supplied
// (legacy/direct callers) means this check is a no-op rather than a reject —
// it only ever tightens grounding where the pipeline actually wired it in.
function numericClaimsGrounded(answerText: any, corpusText: any) {
  if (!corpusText) return true;
  const claims = String(answerText || "").match(NUMERIC_CLAIM_RE) || [];
  if (claims.length === 0) return true;
  const corpusNorm = normalizeForMatch(corpusText);
  return claims.every((claim: any) => corpusNorm.includes(normalizeForMatch(claim)));
}

function exactClaimAllowed(result: any, prog: any, question: any = "", corpus: any = "") {
  if (!result) return false;
  prog = typeof prog === "string" ? programs.get(prog) : prog;
  let structuredSupport = false;
  if (result.groundingVerdict || result.evidence) {
    const programId = idOf(prog);
    if (!programId) return false;
    const checked = grounding.validateClaimSupport({
      verdict: result.groundingVerdict,
      evidence: result.evidence,
      programId,
      fixtureClaims: result.fixtureClaims || [],
    });
    if (!checked.supported) return false;
    structuredSupport = true;
  }

  const sources = programSources(prog);
  const reportedSource = result.source ? result.source.trim().toLowerCase() : "";
  const source = sources.find((candidate: any) => {
    if (!candidate?.name || !reportedSource) return false;
    if (candidate.name.toLowerCase() === reportedSource) return true;
    if (idOf(prog) === "jame-gam" &&
      reportedSource === "jame gam — support & program docs" &&
      candidate.name.toLowerCase() === "jame gam complete docs") return true;
    return knowledge.sourceContainsCitation(candidate, reportedSource);
  });
  if (!source) return !isAuthoritativeOnlyTopic(question, result);
  const freshness = knowledge.sourceEligibility(source);
  if (!(freshness.exactClaimsAllowed || (structuredSupport && freshness.authority !== "dynamic"))) return false;
  return numericClaimsGrounded(result.answer, corpus);
}

function applyGroundingBoundary(result: any, prog: any, question: any = "", corpus: any = "") {
  if (!result) return result;
  const allowed = exactClaimAllowed(result, prog, question, corpus);
  if (!allowed) {
    log.warn("grounding", `rejected program=${idOf(prog) || "none"} source=${result.source || "NONE"} answer_chars=${result.answer?.length || 0} authoritative_only=${isAuthoritativeOnlyTopic(question, result)}`);
    return null;
  }
  return result;
}

function retrievalQuery(question: any, contextPrompt: any = "", prog: any = null) {
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

async function lookupAnswer(question: any, contextPrompt: any = "", prog: any = null, channel: any = null, { isPing = false, skipCache = false }: any = {}) {
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question, prog, contextPrompt);
  if (staged) return staged;

  const query = retrievalQuery(question, contextPrompt, prog);
  const corpus = knowledge.getContext(query, programId);
  let result = await answer.getGroundedAnswer(question, corpus, contextPrompt, prog, channel, { isPing });
  if (result) {
    result = applyGroundingBoundary(result, prog, question, corpus);
  }
  if (result) {
    if (!contextPrompt) cache.put(question, result, cacheScope(prog));
    return result;
  }
  return dateFallback(question, contextPrompt, prog);
}

async function answerOrChat(
  question: any,
  contextPrompt: any = "",
  { onText = null, inHelpChannel = false, program: prog = null, channel = null, allowWebSearch = false, isPing = false, skipCache = false }: any = {},
) {
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
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

  result = applyGroundingBoundary(result, prog, question, corpus);
  if (result?.source && !contextPrompt) cache.put(question, result, cacheScope(prog));
  return result;
}

// WHY: Firecrawl leaves the box only here. lookupAnswer is the docs-only path
// (slash commands, cached flows) — letting it hit the web would bill network
// research to callers that promised a corpus answer and would poison the
// answer cache with unreviewed web text. answerOrChat-only, and only when the
// caller explicitly allows it (pings).
async function webFallback({ question, contextPrompt, corpus, prog, channel, isPing, inHelpChannel, allowWebSearch }: any) {
  if (!allowWebSearch) return null;
  const webResults = await firecrawl.searchWeb(question).catch(() => null);
  if (!webResults || webResults.length === 0) return null;
  const webSnippet = webResults
    .map((r: any) => `Title: ${r.title}\nURL: ${r.url}\n${r.markdown}`)
    .join("\n\n");
  const webContextPrompt = `${contextPrompt}\n\n=== WEB RESEARCH ===\n${webSnippet}`;
  return answer
    .getGroundedAnswer(question, corpus, webContextPrompt, prog, channel, { isPing, inHelpChannel })
    .catch(() => null);
}

function knownAnswer({ question, contextPrompt, mode, program: prog = null, skipCache = false }: any) {
  if (contextPrompt) return null;
  if (link.extractUrl(question)) return null;
  if (mode === DOCS_ONLY) return null;
  return cacheHit(question, contextPrompt, idOf(prog), skipCache);
}

export = {
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
  isAuthoritativeOnlyTopic,
  numericClaimsGrounded,
};
