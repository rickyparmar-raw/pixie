const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseReply, parseAnswerOrChat, normalizeEmoji, NONE_MARKER } = require("./answer");

// The model writes `:3c` because it reads as a kaomoji, and Slack then renders
// it as literal text instead of the custom emoji.
test("normalizeEmoji closes a bare :3c", () => {
  assert.equal(normalizeEmoji("nice one :3c"), "nice one :3c:");
  assert.equal(normalizeEmoji("go for it :3c and lmk"), "go for it :3c: and lmk");
});

test("normalizeEmoji leaves an already-closed :3c: alone", () => {
  assert.equal(normalizeEmoji("all good :3c:"), "all good :3c:");
});

test("normalizeEmoji handles empty input", () => {
  assert.equal(normalizeEmoji(""), "");
  assert.equal(normalizeEmoji(undefined), "");
});

// Slack mrkdwn bold is a single asterisk — **this** renders the asterisks
// literally, which the model does whenever it emphasises a date.
test("normalizeEmoji converts Markdown bold to Slack mrkdwn", () => {
  assert.equal(normalizeEmoji("drops on **august 18, 2026**"), "drops on *august 18, 2026*");
  assert.equal(normalizeEmoji("__emphasis__"), "_emphasis_");
});

test("normalizeEmoji leaves single-asterisk bold and code fences alone", () => {
  assert.equal(normalizeEmoji("already *bold*"), "already *bold*");
  assert.equal(normalizeEmoji("a * b * c"), "a * b * c");
});

test("parseReply closes a bare :3c in the answer", () => {
  const result = parseReply("SOURCE: Pixl FAQ\nANSWER: just sign up :3c");
  assert.equal(result.answer, "just sign up :3c:");
});

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

/* --------------------------------------------- merged answer-or-chat parse -- */
// Three response shapes, all observed against the live model. A source means
// the corpus covered it; a null source drives recordGap/flagForHumans.

test("parseAnswerOrChat reports a grounded answer with its source", () => {
  const result = parseAnswerOrChat("SOURCE: Pixl FAQ\nANSWER: Anyone can join, no team needed.");
  assert.deepEqual(result, { source: "Pixl FAQ", answer: "Anyone can join, no team needed." });
});

// The model pads NONE with trailing spaces and separates the lines with a blank
// one. Comparing without trimming would treat "NONE  " as a real section name
// and cite a source that doesn't exist.
test("parseAnswerOrChat treats a padded NONE as uncovered", () => {
  const result = parseAnswerOrChat("SOURCE: NONE  \n\nANSWER: no clue on that one, ask in #pixl-help :hii:");
  assert.deepEqual(result, { source: null, answer: "no clue on that one, ask in #pixl-help :hii:" });
  assert.equal(parseAnswerOrChat("SOURCE: none\nANSWER: hey").source, null);
});

// Greetings come back as plain prose with no prefix at all. Dropping those sent
// a perfectly good reply to the generic fallback.
test("parseAnswerOrChat treats an unprefixed reply as conversational", () => {
  const result = parseAnswerOrChat("not much, just vibing :3c");
  assert.deepEqual(result, { source: null, answer: "not much, just vibing :3c:" });
});

test("parseAnswerOrChat returns null when the model gave us nothing", () => {
  assert.equal(parseAnswerOrChat(""), null);
  assert.equal(parseAnswerOrChat(undefined), null);
});
