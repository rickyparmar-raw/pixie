const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseReply, NONE_MARKER } = require("./answer");

test("parseReply returns null for the NONE marker", () => {
  assert.equal(parseReply(NONE_MARKER), null);
  assert.equal(parseReply("  NONE  "), null);
});

test("parseReply returns null for empty or missing text", () => {
  assert.equal(parseReply(""), null);
  assert.equal(parseReply(undefined), null);
});

test("parseReply extracts source and answer", () => {
  const raw = "SOURCE: Pixl FAQ\nANSWER: Anyone can join, no team required.";
  const result = parseReply(raw);
  assert.deepEqual(result, {
    source: "Pixl FAQ",
    answer: "Anyone can join, no team required.",
  });
});

test("parseReply handles a missing SOURCE line", () => {
  const raw = "ANSWER: Just the docs, no source given.";
  const result = parseReply(raw);
  assert.deepEqual(result, {
    source: null,
    answer: "Just the docs, no source given.",
  });
});

test("parseReply returns null when there is no ANSWER line", () => {
  assert.equal(parseReply("SOURCE: Pixl FAQ"), null);
});

test("parseReply strips a leading ### from the source if the model echoes the heading", () => {
  const raw = "SOURCE: ### Pixl FAQ\nANSWER: Anyone can join.";
  const result = parseReply(raw);
  assert.deepEqual(result, { source: "Pixl FAQ", answer: "Anyone can join." });
});
