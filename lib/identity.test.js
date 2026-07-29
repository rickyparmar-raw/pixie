const { test } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("./identity");

// These are the exact questions that filled the live gap log — pixie had no
// grounded answer for any of them, so they fell through to the ungrounded chat
// path where it could invent its own backstory.
test("identity covers the questions that actually missed in production", () => {
  const section = identity.corpusSection();
  for (const probe of [/Who are you/i, /Who made you/i, /How are you/i, /What can you do/i]) {
    assert.match(section, probe);
  }
});

test("identity is in the Q/A shape the answer prompt expects", () => {
  const lines = identity.corpusSection().split("\n").filter(Boolean);
  assert.ok(lines.some((l) => l.startsWith("Q: ")));
  assert.ok(lines.some((l) => l.startsWith("A: ")));
});

test("identity credits Ricky and points at the help channel", () => {
  const section = identity.corpusSection();
  assert.match(section, /Ricky/);
  assert.match(section, /#pixl-help/);
});

// Pixorpheus runs in the same channels; conflating the two confuses people
// about which bot handles tickets.
test("identity distinguishes pixie from pixorpheus", () => {
  assert.match(identity.corpusSection(), /Pixorpheus/i);
});

test("identity promises to admit an empty memory rather than invent one", () => {
  assert.match(identity.corpusSection(), /make something up|invent/i);
});
