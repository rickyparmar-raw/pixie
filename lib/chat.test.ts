const { test } = require("node:test");
const assert = require("node:assert/strict");
const { looksLikeCode, looksLikeQuestion } = require("./chat");

test("looksLikeCode detects fenced blocks", () => {
  assert.equal(looksLikeCode("here\n```js\nconst a = 1;\n```"), true);
});

test("looksLikeCode detects stack traces without fences", () => {
  assert.equal(looksLikeCode("TypeError: undefined is not a function"), true);
  assert.equal(looksLikeCode("Traceback (most recent call last):"), true);
  assert.equal(looksLikeCode("panic: runtime error: index out of range"), true);
});

test("looksLikeCode ignores ordinary prose", () => {
  assert.equal(looksLikeCode("how do i unlock the next region"), false);
  assert.equal(looksLikeCode("gg everyone"), false);
});

test("looksLikeQuestion catches question marks and question words", () => {
  assert.equal(looksLikeQuestion("whats the deadline?"), true);
  assert.equal(looksLikeQuestion("how do i join"), true);
  assert.equal(looksLikeQuestion("anyone know about hackatime"), true);
});

test("looksLikeQuestion handles apostrophe-less contractions", () => {
  assert.equal(looksLikeQuestion("pixie whats up"), true);
  assert.equal(looksLikeQuestion("hows the deadline looking"), true);
  assert.equal(looksLikeQuestion("wheres the repo"), true);
});

test("looksLikeQuestion treats greetings as worth a reply", () => {
  assert.equal(looksLikeQuestion("hey pixie"), true);
  assert.equal(looksLikeQuestion("yo"), true);
  assert.equal(looksLikeQuestion("thanks!"), true);
});

test("looksLikeQuestion is false for statements and empties", () => {
  assert.equal(looksLikeQuestion("pixie ur the best"), false);
  assert.equal(looksLikeQuestion(""), false);
  assert.equal(looksLikeQuestion(undefined), false);
});

test("looksLikeQuestion treats pasted code as something to respond to", () => {
  assert.equal(looksLikeQuestion("```\nSyntaxError: bad\n```"), true);
});

test("chat prompts stay helpful but defer configured facts to documentation", () => {
  const chat = require("./chat");
  const sys = chat.chatSystemPrompt("", false);
  const dbg = chat.debugSystemPrompt("", false);
  assert.match(sys, /you do NOT know the answer/i);
  assert.match(dbg, /you do NOT know the answer/i);
  assert.match(sys, /1-3 sentences/);
});
export {};
