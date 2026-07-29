const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isRetryableStatus, isRetryableError } = require("./llm");

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
