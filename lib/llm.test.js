const { test } = require("node:test");
const assert = require("node:assert/strict");
const llm = require("./llm");
const { isRetryableStatus, isRetryableError } = llm;

test("isRetryableStatus covers throttling and server errors", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, String(status));
  }
});

// Retrying a bad key or a malformed request just makes the failure slower.
test("isRetryableStatus rejects client errors we cannot recover from", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableStatus(status), false, String(status));
  }
});

test("isRetryableError treats a missing response as retryable", () => {
  assert.equal(isRetryableError(new Error("socket hang up")), true);
  assert.equal(isRetryableError({ code: "ECONNABORTED" }), true);
});

test("isRetryableError defers to the status when there is a response", () => {
  assert.equal(isRetryableError({ response: { status: 429 } }), true);
  assert.equal(isRetryableError({ response: { status: 401 } }), false);
});

/* ------------------------------------------------------------ SSE parsing -- */

const sse = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`;

test("parseSseChunk pulls the content deltas out of complete lines", () => {
  const { deltas, rest } = llm.parseSseChunk(`${sse("he")}${sse("llo")}`);
  assert.deepEqual(deltas, ["he", "llo"]);
  assert.equal(rest, "");
});

// Frames arrive split across network chunks, so half a line has to survive
// until the rest of it shows up.
test("parseSseChunk holds back a partial line", () => {
  const whole = sse("hi");
  const cut = whole.length - 4;

  const first = llm.parseSseChunk(whole.slice(0, cut));
  assert.deepEqual(first.deltas, []);

  const second = llm.parseSseChunk(first.rest + whole.slice(cut));
  assert.deepEqual(second.deltas, ["hi"]);
});

test("parseSseChunk ignores [DONE], keepalives and unparseable frames", () => {
  const { deltas } = llm.parseSseChunk('data: [DONE]\n\ndata: {not json}\n: keepalive\ndata: {"choices":[{}]}\n');
  assert.deepEqual(deltas, []);
});

/* -------------------------------------------------------------- streaming -- */

// Stands in for the endpoint: hands the frames back as one readable stream.
function fakeFetch(chunks, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => "boom",
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () =>
            i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]) } : { done: true },
        };
      },
    },
  });
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

const REQUEST = { baseUrl: "http://x", apiKey: "k", model: "m", messages: [] };

test("completeStream assembles the deltas and reports each one as it lands", async () => {
  const seen = [];
  const result = await withFetch(fakeFetch([sse("one "), sse("two"), "data: [DONE]\n"]), () =>
    llm.completeStream(REQUEST, (delta, text) => seen.push([delta, text])),
  );

  assert.equal(result.text, "one two");
  assert.deepEqual(seen, [
    ["one ", "one "],
    ["two", "one two"],
  ]);
});

// The SILENT gate has to stop a stream the moment it knows there is nothing to
// say, rather than paying for the rest of a completion it throws away.
test("completeStream stops when the callback returns false", async () => {
  const seen = [];
  const result = await withFetch(fakeFetch([sse("SILENT"), sse(" and more")]), () =>
    llm.completeStream(REQUEST, (delta) => {
      seen.push(delta);
      return false;
    }),
  );

  assert.deepEqual(seen, ["SILENT"]);
  assert.equal(result.stopped, true);
  assert.equal(result.text, "SILENT");
});

test("completeStream retries an attempt that streamed nothing", async () => {
  let attempts = 0;
  const flaky = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error("503");
      err.response = { status: 503 };
      throw err;
    }
    return fakeFetch([sse("recovered")])(...args);
  };

  const result = await withFetch(flaky, () => llm.completeStream(REQUEST, () => {}));

  assert.equal(attempts, 2);
  assert.equal(result.text, "recovered");
});

// Once a fragment is on screen a retry would rewrite the reply in front of
// whoever is reading it, so a mid-stream failure has to surface instead.
test("completeStream does not retry once text has been streamed", async () => {
  let attempts = 0;
  const breaksMidStream = async () => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let first = true;
          return {
            read: async () => {
              if (!first) throw new Error("socket hang up");
              first = false;
              return { done: false, value: new TextEncoder().encode(sse("half an ans")) };
            },
          };
        },
      },
    };
  };

  await withFetch(breaksMidStream, async () => {
    await assert.rejects(() => llm.completeStream(REQUEST, () => {}), /socket hang up/);
  });
  assert.equal(attempts, 1);
});

test("completeStream throws a non-retryable status straight away", async () => {
  let attempts = 0;
  const unauthorized = async (...args) => {
    attempts += 1;
    return fakeFetch([], { status: 401 })(...args);
  };

  await withFetch(unauthorized, async () => {
    await assert.rejects(() => llm.completeStream(REQUEST, () => {}), /HTTP 401/);
  });
  assert.equal(attempts, 1);
});
