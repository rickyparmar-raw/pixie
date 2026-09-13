// Characterization of the terminal disposition helpers extracted from
// lib/respond.js. Mirrors the existing respond.test.js terminal cases (which
// stay unmodified) as pure-mapping assertions against lib/disposition.js.
//
// NOTE: prod (lib/respond.js) uses only gateShouldSilence/isUnclearResult; the
// former decideDisposition/isMissingResult mapping was unwired and has been
// removed. This file keeps full coverage of the remaining helpers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const disposition = require("./disposition");
const { isUnclearResult, gateShouldSilence } = disposition;

/* ------------------------------------------------------- shape predicates -- */

test("isUnclearResult speaks parseReply/parseAnswerOrChat shapes", () => {
  assert.equal(isUnclearResult({ source: null, answer: "", unclear: true }), true);
  assert.equal(isUnclearResult({ source: "NONE", answer: "UNCLEAR" }), true);
  assert.equal(isUnclearResult({ source: "NONE", answer: "  unclear  " }), true);
  assert.equal(isUnclearResult({ source: null, answer: "yeah man totally" }), false);
  assert.equal(isUnclearResult({ source: null, answer: "unclear on that one, but the deadline is the 18th" }), false);
  assert.equal(isUnclearResult(null), false);
  assert.equal(isUnclearResult(undefined), false);
});

test("gateShouldSilence: denial and null-verdict silence, pass and no-gate do not", () => {
  assert.equal(gateShouldSilence(null), true, "HELP_ONLY null verdict is fail-soft silence");
  assert.equal(gateShouldSilence({ shouldAttemptAnswer: false, verdict: "CASUAL_CHAT" }), true);
  assert.equal(gateShouldSilence({ shouldAttemptAnswer: false, verdict: "OFF_TOPIC" }), true);
  assert.equal(gateShouldSilence({ shouldAttemptAnswer: true, verdict: "HELP_NEEDED" }), false);
  assert.equal(gateShouldSilence(undefined), false, "no gate ran at all — not a denial");
});

/* ------------------------------------------------------- marker parity -- */
// lib/disposition.js deliberately duplicates UNCLEAR_MARKER instead of
// require()ing answer.js (which would drag the llm chain). This guard fails
// loudly if the two ever desync.
test("UNCLEAR_MARKER stays in sync with lib/answer.js", () => {
  const answer = require("./answer");
  assert.equal(disposition.UNCLEAR_MARKER, answer.UNCLEAR_MARKER);
});
