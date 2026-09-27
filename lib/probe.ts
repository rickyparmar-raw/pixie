
const answer = require("./answer");
const knowledge = require("./knowledge");
const retrieve = require("./retrieve");
const cache = require("./cache");
const intent = require("./intent");

type Chunk = { source: string; heading?: string; text: string };
type Rank = { chunk: Chunk; value: number };
interface CacheEntry { source: string; answer: string; askCount: number; ageMs: number }
interface CacheVerdict { cacheKey: string | null; cacheHit: CacheEntry | null; wouldHit: boolean; wouldMiss: boolean }
interface AnswerResult { source: string | null; answer: string | null }
interface ProbeResult {
  error?: string;
  question?: string;
  source?: string | null;
  answer?: string | null;
  latencyMs?: number;
  firstTokenMs?: number | null;
  cacheWouldHit?: boolean;
  cacheWouldMiss?: boolean;
  cacheKey?: string | null;
  cacheEntry?: { source: string; answer: string; askCount: number; ageMs: number } | null;
  queryTerms?: string[];
  retrievalTrace?: Array<{ source: string; heading: string | null; snippet: string; length: number }>;
  bm25Trace?: Array<{ source: string; heading: string | null; snippet: string; bm25: number }>;
  citationOk?: boolean | null;
  gateVerdict?: string | null;
  generatedSections?: Array<{ name: string; length: number }>;
  corpusSize?: number;
  chunkCount?: number;
}

function elapsedMs(since: number): number {
  return Math.round((performance.now() - since) * 1000) / 1000;
}

function cacheVerdict(question: string): CacheVerdict {
  const cacheKey = cache.keyFor(question);
  const cacheHit = cacheKey ? cache.peekCachedAnswer(cacheKey) : null;
  if (!cacheHit) return { cacheKey, cacheHit: null, wouldHit: false, wouldMiss: true };
  const forcedMiss = cache.isVolatile(cacheHit.source) && cacheHit.ageMs > require("./db").CACHE_FRESH_MS;
  return { cacheKey, cacheHit, wouldHit: true, wouldMiss: forcedMiss };
}

function citationCheck(source: string | null, chunks: Chunk[]): boolean | null {
  if (!source) return null;
  return new Set(chunks.map((c) => c.source)).has(source);
}

function traceChunk(c: Chunk, snippetLen: number) {
  return {
    source: c.source,
    heading: c.heading || null,
    snippet: c.text.slice(0, snippetLen),
    length: c.text.length,
  };
}

async function probe(question: string): Promise<ProbeResult> {
  const startedAt = performance.now();
  const q = (question || "").trim();
  if (!q) return { error: "empty question" };

  const corpus = knowledge.getContext(q);
  const index = knowledge.getIndex();

  const { cacheKey, cacheHit, wouldHit: cacheWouldHit, wouldMiss: cacheWouldMiss } = cacheVerdict(q);

  const queryTerms = retrieve.tokenize(q);

  const chunks = retrieve.selectChunks(index, q, retrieve.DEFAULT_BUDGET);
  const retrievalTrace = chunks.map((c: Chunk) => traceChunk(c, 200));

  const ranking = retrieve.score(index, queryTerms);
  const bm25Trace = ranking.map((r: Rank) => ({
    source: r.chunk.source,
    heading: r.chunk.heading || null,
    snippet: r.chunk.text.slice(0, 150),
    bm25: Math.round(r.value * 1000) / 1000,
  }));

  let firstTokenMs: number | null = null;
  let answerText: string | null = null;
  let source: string | null = null;
  let result: AnswerResult | null = null;

  try {
    result = await answer.getAnswerOrChatStream(q, corpus, "", {
      onText: (text: string) => {
        if (firstTokenMs === null) firstTokenMs = elapsedMs(startedAt);
        answerText = text;
      },
    });
  } catch (e) {
    return {
      question: q,
      error: e instanceof Error ? e.message : String(e),
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

  const citationOk = citationCheck(source, chunks);

  let gateVerdict: string | null = null;
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
    generatedSections: generated.map(([name, text]: [string, string]) => ({ name, length: text.length })),
    corpusSize: corpus.length,
    chunkCount: index.docs.length,
  };
}

export = { probe };
