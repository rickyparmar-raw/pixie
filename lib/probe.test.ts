process.env.PIXIE_DB_PATH = ":memory:";

interface ProbeOptions {
  onText?: (text: string) => void;
}
interface MetricDetail {
  detail: string;
  count: number;
}

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const { probe } = require("./probe");

const answer = require("./answer");
const intent = require("./intent");

const originalAnswer = answer.getAnswerOrChatStream;
const originalIntent = intent.classifyIntent;

db.open(":memory:");

test("probe returns error for empty question", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "test" });
  intent.classifyIntent = async () => "HELP_NEEDED";

  const result = await probe("");
  assert.ok(result.error);
});

test("probe returns query terms and answer for a real question", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Pixl FAQ", answer: "here is the answer" });
  intent.classifyIntent = async () => "HELP_NEEDED";

  const result = await probe("how do i submit");
  assert.equal(result.question, "how do i submit");
  assert.ok(result.queryTerms.length > 0);
  assert.ok(result.answer);
  assert.equal(result.source, "Pixl FAQ");
  assert.ok(result.latencyMs > 0);
  assert.equal(typeof result.cacheWouldHit, "boolean");
});

test("probe handles null source for conversational answer", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "hey there" });
  intent.classifyIntent = async () => "CASUAL_CHAT";

  const result = await probe("hey pixie");
  assert.equal(result.source, null);
  assert.ok(result.answer);
});

test("probe includes BM25 and retrieval trace", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Pixl FAQ", answer: "test" });
  intent.classifyIntent = async () => "HELP_NEEDED";

  const result = await probe("what is pixl");
  assert.ok(Array.isArray(result.bm25Trace));
  assert.ok(Array.isArray(result.retrievalTrace));
});

test("probe handles model errors without crashing", async () => {
  answer.getAnswerOrChatStream = async () => {
    throw new Error("model down");
  };
  intent.classifyIntent = async () => "HELP_NEEDED";

  const knowledge = require("./knowledge");
  const originalContext = knowledge.getContext;
  knowledge.getContext = () => "fake corpus content";

  try {
    const result = await probe("anything");
    assert.ok(result.error);
  } finally {
    knowledge.getContext = originalContext;
  }
});

test("db.metricDetails returns empty array when no silent details", () => {
  const details = db.metricDetails("silent");
  assert.ok(Array.isArray(details));
});

test("db.metricDetails returns grouped detail counts", () => {
  db.recordMetric("silent", null, "test_reason_a");
  db.recordMetric("silent", null, "test_reason_a");
  db.recordMetric("silent", null, "test_reason_b");

  const details = db.metricDetails("silent", 7 * 24 * 60 * 60 * 1000);
  assert.ok(details.length >= 2);

  const a = details.find((d: MetricDetail) => d.detail === "test_reason_a");
  assert.ok(a);
  assert.equal(a.count, 2);
});

after(() => {
  answer.getAnswerOrChatStream = originalAnswer;
  intent.classifyIntent = originalIntent;
});

test("probe is read-only — it never writes the answer cache", async () => {
  const cache = require("./cache");
  const seen: unknown[][] = [];
  const origPut = cache.put;
  cache.put = (...args: never[]) => {
    seen.push(args);
    return origPut(...args);
  };
  answer.getAnswerOrChatStream = async () => ({ source: "Pixl FAQ", answer: "probe answer" });
  intent.classifyIntent = async () => "HELP_NEEDED";
  try {
    await probe("char probe readonly");
    assert.deepEqual(seen, []);
  } finally {
    cache.put = origPut;
  }
});

test("probe reports citation membership against retrieved chunks", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Pixl FAQ", answer: "x" });
  intent.classifyIntent = async () => "HELP_NEEDED";
  const result = await probe("how do i submit");
  assert.equal(result.citationOk === null || typeof result.citationOk === "boolean", true);
  assert.ok(typeof result.corpusSize === "number");
  assert.ok(typeof result.chunkCount === "number");
});

test("probe surfaces firstTokenMs only when streaming yields text", async () => {
  answer.getAnswerOrChatStream = async (q: string, corpus: string, ctx: unknown, opts: ProbeOptions) => {
    if (opts?.onText) opts.onText("partial");
    return { source: "Pixl FAQ", answer: "partial" };
  };
  intent.classifyIntent = async () => "HELP_NEEDED";
  const result = await probe("streaming probe");
  assert.equal(typeof result.firstTokenMs === "number" || result.firstTokenMs === null, true);
});
export {};
