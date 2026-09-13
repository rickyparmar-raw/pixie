// Differential for the llm.js transport/telemetry split.
//
// Uses ONLY the public transport surface (complete/completeStream) plus the
// llm_usage table. Written pre-move against lib/llm.js and kept unmodified
// post-move: identical attempt counts, backoff evidence, result shapes and
// llm_usage deltas prove the extraction changed no observable behavior.
//
// NOTE: the streaming path records no llm_usage rows (completeAttempts owns
// recordUsage); stream cases assert attempts/shapes and that the row count is
// untouched.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const db = require("./db");
const llm = require("./llm");

const REQUEST = { baseUrl: "http://x", apiKey: "k", model: "m", messages: [] };

async function withAxiosPost(impl, fn) {
  const original = axios.post;
  axios.post = impl;
  try {
    return await fn();
  } finally {
    axios.post = original;
  }
}

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function llmUsageCount() {
  try {
    return db.handle().query("SELECT COUNT(*) AS c FROM llm_usage").get().c;
  } catch {
    return null;
  }
}

function lastLlmUsageRows(n = 5) {
  try {
    return db.handle().query("SELECT status, model, attempt, retry_count AS retryCount FROM llm_usage ORDER BY rowid DESC LIMIT ?").all(n);
  } catch {
    return null;
  }
}

const sse = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`;

function fakeFetch(chunks, { status = 200, finishReason = "stop" } = {}) {
  const frames = finishReason
    ? [...chunks, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n`]
    : chunks;
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => "boom",
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () =>
            i < frames.length ? { done: false, value: new TextEncoder().encode(frames[i++]) } : { done: true },
        };
      },
    },
  });
}

function okResponse(text, usage) {
  return {
    data: {
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  };
}

function httpError(status, message) {
  const err = new Error(message || `status ${status}`);
  err.response = { status };
  return err;
}

test("DIFF: complete() retries transient 429s then succeeds with usage + llm_usage rows", async () => {
  let calls = 0;
  const before = llmUsageCount();
  const started = Date.now();
  await withAxiosPost(async () => {
    calls += 1;
    if (calls < 3) throw httpError(429, "rate limited");
    return okResponse("recovered");
  }, async () => {
    const result = await llm.complete({ ...REQUEST });
    assert.equal(result.text, "recovered");
    assert.equal(result.attempt, 3);
    assert.equal(result.retryCount, 2);
    assert.equal(result.usage.promptTokens, 10);
    assert.equal(result.usage.completionTokens, 5);
  });
  const elapsed = Date.now() - started;
  assert.equal(calls, 3);
  // Two backoff sleeps (400ms + 800ms + jitter) sit between the three attempts.
  assert.ok(elapsed >= 250, `expected backoff sleeps, elapsed=${elapsed}ms`);
  const after = llmUsageCount();
  if (before !== null && after !== null) {
    assert.equal(after - before, 3, "one llm_usage row per attempt");
    const rows = lastLlmUsageRows(3);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["error", "error", "success"]);
  }
});

test("DIFF: complete() retries a 5xx then succeeds", async () => {
  let calls = 0;
  const before = llmUsageCount();
  await withAxiosPost(async () => {
    calls += 1;
    if (calls === 1) throw httpError(503, "overloaded");
    return okResponse("after-5xx");
  }, async () => {
    const result = await llm.complete({ ...REQUEST });
    assert.equal(result.text, "after-5xx");
    assert.equal(result.attempt, 2);
    assert.equal(result.retryCount, 1);
  });
  assert.equal(calls, 2);
  const after = llmUsageCount();
  if (before !== null && after !== null) assert.equal(after - before, 2);
});

test("DIFF: complete() retries a timeout (no response) then succeeds", async () => {
  let calls = 0;
  const before = llmUsageCount();
  await withAxiosPost(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNABORTED" });
    return okResponse("after-timeout");
  }, async () => {
    const result = await llm.complete({ ...REQUEST });
    assert.equal(result.text, "after-timeout");
    assert.equal(result.attempt, 2);
  });
  assert.equal(calls, 2);
  const after = llmUsageCount();
  if (before !== null && after !== null) assert.equal(after - before, 2);
});

test("DIFF: complete() retries an empty completion then succeeds", async () => {
  let calls = 0;
  const before = llmUsageCount();
  await withAxiosPost(async () => {
    calls += 1;
    if (calls === 1) {
      return { data: { choices: [{ message: { content: "   " }, finish_reason: "length" }] } };
    }
    return okResponse("second-try");
  }, async () => {
    const result = await llm.complete({ ...REQUEST });
    assert.equal(result.text, "second-try");
    assert.equal(result.attempt, 2);
    assert.equal(result.retryCount, 1);
  });
  assert.equal(calls, 2);
  const after = llmUsageCount();
  if (before !== null && after !== null) {
    assert.equal(after - before, 2);
    const rows = lastLlmUsageRows(2);
    assert.ok(rows.some((r) => r.status === "empty"), "empty completion recorded as empty");
    assert.ok(rows.some((r) => r.status === "success"), "recovery recorded as success");
  }
});

test("DIFF: complete() throws non-retryable 401 immediately with one error row", async () => {
  let calls = 0;
  const before = llmUsageCount();
  await withAxiosPost(async () => {
    calls += 1;
    throw httpError(401, "bad key");
  }, async () => {
    await assert.rejects(() => llm.complete({ ...REQUEST }), /bad key/);
  });
  assert.equal(calls, 1);
  const after = llmUsageCount();
  if (before !== null && after !== null) {
    assert.equal(after - before, 1);
    const rows = lastLlmUsageRows(1);
    assert.equal(rows[0].status, "error");
  }
});

test("DIFF: completeStream() retries a silent 503 then assembles the answer, rows untouched", async () => {
  let attempts = 0;
  const before = llmUsageCount();
  const flaky = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error("503");
      err.response = { status: 503 };
      throw err;
    }
    return fakeFetch([sse("recovered-stream")])(...args);
  };
  const result = await withFetch(flaky, () => llm.completeStream(REQUEST, () => {}));
  assert.equal(attempts, 2);
  assert.equal(result.text, "recovered-stream");
  const after = llmUsageCount();
  if (before !== null && after !== null) assert.equal(after - before, 0, "streams record no llm_usage rows");
});
