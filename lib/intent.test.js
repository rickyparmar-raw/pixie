const { test } = require("node:test");
const assert = require("node:assert/strict");
const { couldNeedHelp, looksLikeHelpRequest } = require("./intent");

/* ------------------------------------------------------------ couldNeedHelp -- */
// Decides whether a message is worth a classifier call. Negative filter: when
// unsure it must say true and pay for the call.

test("couldNeedHelp keeps anything that could be a real request", () => {
  assert.equal(couldNeedHelp("how do i submit my project?"), true);
  // No question mark and no question word — a pure question-shape filter would
  // drop a genuine help request here.
  assert.equal(couldNeedHelp("my build broke"), true);
  assert.equal(couldNeedHelp("sprite wont load"), true);
  assert.equal(couldNeedHelp("```TypeError: undefined is not a function```"), true);
  // No signal at all, but long enough that it might be someone describing a
  // problem in plain statements.
  assert.equal(couldNeedHelp("the sprite sheet renders upside down"), true);
});

test("couldNeedHelp skips messages with no help signal", () => {
  assert.equal(couldNeedHelp(""), false);
  assert.equal(couldNeedHelp(undefined), false);
  assert.equal(couldNeedHelp("lets go"), false);
});

// The message that made pixie hand out an unsolicited opinion in #pixl.
test("couldNeedHelp skips people thinking out loud", () => {
  assert.equal(
    couldNeedHelp("wait WHAT IF I JS GET 60 DIFFERENT API KEYS AND KEEP ON USING ROUND ROBIN :sho:"),
    false,
  );
  assert.equal(couldNeedHelp("imagine if the whole thing was written in rust"), false);
  assert.equal(couldNeedHelp("lmao that would be so cursed"), false);
});

// A bare negative contraction is ordinary negation, not a problem report. This
// stays true for the loose filter too: two words with nothing else in them is
// not worth a classifier call.
test("couldNeedHelp skips a fragment whose only signal is a bare contraction", () => {
  assert.equal(couldNeedHelp("ridit isn't"), false);
  assert.equal(couldNeedHelp("that cant be"), false);
});

test("couldNeedHelp still keeps a contraction attached to a failing verb", () => {
  assert.equal(couldNeedHelp("the build wont start"), true);
  assert.equal(couldNeedHelp("my tileset doesnt render"), true);
});

// Banter markers are only consulted once every positive signal has missed, so a
// real question is never dropped for containing one.
test("couldNeedHelp keeps a real question that contains a banter marker", () => {
  assert.equal(couldNeedHelp("what if my build breaks halfway through?"), true);
  assert.equal(couldNeedHelp("lol what if this is why my deploy fails"), true);
});

/* ------------------------------------------------------ looksLikeHelpRequest -- */
// The HELP_ONLY gate: may pixie speak when nobody addressed it? Stricter than
// couldNeedHelp — small talk has to fail this.

test("looksLikeHelpRequest accepts someone asking the room for something", () => {
  assert.equal(looksLikeHelpRequest("how do i connect hackatime"), true);
  assert.equal(looksLikeHelpRequest("anyone know why this wont build"), true);
  assert.equal(looksLikeHelpRequest("should i use godot or unity for this"), true);
  assert.equal(looksLikeHelpRequest("where do i submit"), true);
  assert.equal(looksLikeHelpRequest("my sprite sheet is broken"), true);
  assert.equal(looksLikeHelpRequest("```ReferenceError: x is not defined```"), true);
});

// The whole point of the mode: unaddressed small talk gets silence, not a
// friendly one-liner.
test("looksLikeHelpRequest rejects small talk and riffing", () => {
  assert.equal(looksLikeHelpRequest("hi guys"), false);
  assert.equal(looksLikeHelpRequest("whats up everyone"), false);
  assert.equal(looksLikeHelpRequest("imagine if the whole thing was written in rust"), false);
  assert.equal(looksLikeHelpRequest("gonna rewrite this tonight"), false);
  assert.equal(looksLikeHelpRequest("this shop pricing is so unbalanced ngl"), false);
  assert.equal(looksLikeHelpRequest(""), false);
  assert.equal(looksLikeHelpRequest(undefined), false);
});

// The message that got "sorry, what about ridit? could you clarify what you
// mean?" — half a sentence someone sent by hitting enter early. It cleared the
// gate purely because "isn't" was on the problem-word list.
test("looksLikeHelpRequest rejects a fragment ending in a bare contraction", () => {
  assert.equal(looksLikeHelpRequest("ridit isn't"), false);
  assert.equal(looksLikeHelpRequest("nah it wont"), false);
  assert.equal(looksLikeHelpRequest("i cant"), false);
});

test("looksLikeHelpRequest accepts a contraction that names what is failing", () => {
  assert.equal(looksLikeHelpRequest("my sprite wont load"), true);
  assert.equal(looksLikeHelpRequest("the editor isnt showing my tiles"), true);
  assert.equal(looksLikeHelpRequest("hackatime doesnt connect for me"), true);
});

// Two words is a fragment or an aside, never a request put to the room. Code is
// the exception — a pasted trace is short on words and obviously someone stuck.
test("looksLikeHelpRequest rejects fragments but not short code", () => {
  assert.equal(looksLikeHelpRequest("stuck lol"), false);
  assert.equal(looksLikeHelpRequest("build broke"), false);
  assert.equal(looksLikeHelpRequest("```segfault```"), true);
});
