// Glass-box answer for the web console. Calls the layer BELOW lookup so it
// records nothing — no cache_hit metric, no cache.put, no gap. The playground
// must be invisible to the stats or every test question would silently corrupt
// the coverage rate.

const answer = require("./answer");
const knowledge = require("./knowledge");
const retrieve = require("./retrieve");
const cache = require("./cache");
const intent = require("./intent");

// Date.now() has 1ms granularity, which is coarse for the one panel whose whole
// job is reporting how long things took — a cache hit or a stubbed call lands on
// exactly 0ms and reads as "unmeasured". performance.now() is sub-millisecond.
function elapsedMs(since) {
  return Math.round((performance.now() - since) * 1000) / 1000;
}

// What the cache would have done — reported, never acted on. Note a stale
// volatile entry reports BOTH wouldHit and wouldMiss: the key exists, but the
// answer path would refuse to serve it.
function cacheVerdict(question) {
  const cacheKey = cache.keyFor(question);
  const cacheHit = cacheKey ? cache.peekCachedAnswer(cacheKey) : null;
  if (!cacheHit) return { cacheKey, cacheHit: null, wouldHit: false, wouldMiss: true };
  // Only volatile entries past freshness are forced misses.
  const forcedMiss = cache.isVolatile(cacheHit.source) && cacheHit.ageMs > require("./db").CACHE_FRESH_MS;
  return { cacheKey, cacheHit, wouldHit: true, wouldMiss: forcedMiss };
}

// Does the cited source appear in the retrieved chunks? Null when there is no
// citation to check — absence of evidence, not evidence of absence.
function citationCheck(source, chunks) {
  if (!source) return null;
  return new Set(chunks.map((c) => c.source)).has(source);
}

function traceChunk(c, snippetLen) {
  return {
    source: c.source,
    heading: c.heading || null,
    snippet: c.text.slice(0, snippetLen),
    length: c.text.length,
  };
}

async function probe(question) {
  const startedAt = performance.now();
  const q = (question || "").trim();
  if (!q) return { error: "empty question" };

  const corpus = knowledge.getContext(q);
  const index = knowledge.getIndex();

  const { cacheKey, cacheHit, wouldHit: cacheWouldHit, wouldMiss: cacheWouldMiss } = cacheVerdict(q);

  // Query terms that survived stopword stripping.
  const queryTerms = retrieve.tokenize(q);

  // Retrieval trace.
  const chunks = retrieve.selectChunks(index, q, retrieve.DEFAULT_BUDGET);
  const retrievalTrace = chunks.map((c) => traceChunk(c, 200));

  // Full retrieval ranking for inspection.
  const ranking = retrieve.score(index, queryTerms);
  const bm25Trace = ranking.map((r) => ({
    source: r.chunk.source,
    heading: r.chunk.heading || null,
    snippet: r.chunk.text.slice(0, 150),
    bm25: Math.round(r.value * 1000) / 1000,
  }));

  // Model answer.
  let firstTokenMs = null;
  let answerText = null;
  let source = null;
  let result = null;

  try {
    result = await answer.getAnswerOrChatStream(q, corpus, "", {
      onText: (text) => {
        if (firstTokenMs === null) firstTokenMs = elapsedMs(startedAt);
        answerText = text;
      },
    });
  } catch (e) {
    return {
      question: q,
      error: e.message,
      latencyMs: elapsedMs(startedAt),
      queryTerms,
      retrievalTrace,
      bm25Trace,
      cacheWouldHit,
      cacheKey,
    };
  }

  const latencyMs = elapsedMs(startedAt);

  if (result) {
    source = result.source;
    answerText = result.answer;
  }

  // Citation check: does the cited source appear in the retrieved chunks?
  const citationOk = citationCheck(source, chunks);

  // Intent gate.
  let gateVerdict = null;
  try {
    gateVerdict = await intent.classifyIntent(q);
  } catch (_) {}

  const generated = knowledge.generatedSections();

  return {
    question: q,
    source,
    answer: answerText,
    latencyMs,
    firstTokenMs,
    cacheWouldHit,
    cacheWouldMiss,
    cacheKey,
    cacheEntry: cacheHit ? { source: cacheHit.source, answer: cacheHit.answer, askCount: cacheHit.askCount, ageMs: cacheHit.ageMs } : null,
    queryTerms,
    retrievalTrace,
    bm25Trace,
    citationOk,
    gateVerdict,
    generatedSections: generated.map(([name, text]) => ({ name, length: text.length })),
    corpusSize: corpus.length,
    chunkCount: index.docs.length,
  };
}

module.exports = { probe };
