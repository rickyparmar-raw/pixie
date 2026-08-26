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

const DOCS_ONLY = "docs-only";

// Callers hand over whichever they have. The corpus, the answer cache and the
// timeline all key off the id; the prompt needs the whole record so it can name
// the program and its help channel. Splitting them here means neither caller
// nor answer.js has to care which form arrived.
function idOf(program) {
  if (!program) return null;
  return typeof program === "string" ? program : program.id || null;
}

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
//
// This was calling `directAnswer(question, programId)` — and directAnswer's
// second parameter is the current date, not a program. Every timing question
// that got this far threw `now.getTime is not a function`, which respond()
// caught and turned into the generic error reply. The whole path was dead, and
// silently: the throw looked like any other failed lookup.
function dateFallback(question, contextPrompt, prog = null) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const programId = idOf(record || prog);
  const milestones = record?.milestones || programs.shared().milestones;

  const direct = program.directAnswer(question, new Date(), milestones, record);
  if (direct && !contextPrompt) cache.put(question, direct, programId);
  return direct;
}

// Prices and the hours behind them, worked out in code rather than asked for.
//
// This runs *before* the model, not as a fallback after it, which is the
// opposite of dateFallback: the docs genuinely cannot answer "how much is a
// PS5" — prices are live and the shop is the only place they exist — and a
// model handed the catalogue will still get the payout-table arithmetic wrong.
// Returns null for anything that isn't a shop question, which is nearly
// everything, and that goes on to the normal path untouched.
//
// Deliberately never cached: prices move when someone restocks, and half of
// these answers are a question back rather than a fact.
function shopAnswer(question, prog, history = "") {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const sources = [...(record?.sources || []), ...(programs.shared().sources || [])];
  if (!sources.some((s) => s && s.type === "pixl-shop")) return null;

  const data = shop.current();
  if (!data.items.length) return null;

  // The thread is handed over so a reply of just "t4" can find the item pixie
  // was asked about a moment ago.
  const result = shop.directAnswer(question, data, { history });
  if (result) db.recordMetric("answer_shop");
  return result;
}

async function lookupAnswer(question, contextPrompt = "", prog = null, channel = null) {
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, programId);
  if (hit) return hit;

  const shopped = shopAnswer(question, prog, contextPrompt);
  if (shopped) return shopped;

  const corpus = knowledge.getContext(question, programId);
  const result = await answer.getGroundedAnswer(question, corpus, contextPrompt, prog, channel);
  if (result) {
    if (!contextPrompt) cache.put(question, result, programId);
    return result;
  }
  return dateFallback(question, contextPrompt, prog);
}

async function answerOrChat(
  question,
  contextPrompt = "",
  { onText = null, inHelpChannel = false, program: prog = null, channel = null } = {},
) {
  // Renamed on the way in: `program` at module scope is the timeline module,
  // and shadowing it inside this function is how you get a very confusing bug.
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, programId);
  if (hit) return hit;

  const shopped = shopAnswer(question, prog, contextPrompt);
  if (shopped) return shopped;

  const corpus = knowledge.getContext(question, programId);
  let result = onText
    ? await answer.getAnswerOrChatStream(question, corpus, contextPrompt, { onText, inHelpChannel, program: prog, channel })
    : await answer.getAnswerOrChat(question, corpus, contextPrompt, inHelpChannel, prog, channel);

  if (!result?.source) {
    const direct = dateFallback(question, contextPrompt, prog);
    if (direct) return direct;

    // Web research fallback when Firecrawl API key is present and corpus had no answer
    const webResults = await firecrawl.searchWeb(question).catch(() => null);
    if (webResults && webResults.length > 0) {
      const webSnippet = webResults
        .map((r) => `Title: ${r.title}\nURL: ${r.url}\n${r.markdown}`)
        .join("\n\n");
      const webContextPrompt = `${contextPrompt}\n\n=== WEB RESEARCH ===\n${webSnippet}`;
      const webResult = await answer
        .getGroundedAnswer(question, corpus, webContextPrompt, prog, channel)
        .catch(() => null);
      if (webResult) {
        result = webResult;
      }
    }
  }

  if (result?.source && !contextPrompt) cache.put(question, result, programId);
  return result;
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
  dateFallback,
  lookupAnswer,
  answerOrChat,
  knownAnswer,
};
