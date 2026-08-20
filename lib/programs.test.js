process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");

db.open(":memory:");

/* ----------------------------------------------------------------- scope -- */
// What pixie answers when nobody addressed her: everything someone's stuck on,
// or only this program's questions. Stored per program so one deployment can
// run a locked-down #pixl next to an open #sprig-help.

test("scope defaults to any, so an existing program keeps answering everything", () => {
  programs.saveProgram({ id: "t-open", name: "Open Program" });
  assert.equal(programs.scope("t-open"), "any");
  assert.equal(programs.isProgramScoped(programs.get("t-open")), false);
});

test("scope survives a round trip through the database", () => {
  programs.saveProgram({ id: "t-scoped", name: "Scoped Program", scope: "program" });
  programs.invalidate();

  const loaded = programs.get("t-scoped");
  assert.equal(loaded.scope, "program");
  assert.equal(programs.scope("t-scoped"), "program");
  assert.equal(programs.isProgramScoped(loaded), true);
  assert.equal(programs.isProgramScoped("t-scoped"), true);
});

test("scope can be flipped back without a redeploy", () => {
  programs.saveProgram({ id: "t-flip", name: "Flip", scope: "program" });
  assert.equal(programs.scope("t-flip"), "program");

  programs.saveProgram({ ...programs.get("t-flip"), scope: "any" });
  assert.equal(programs.scope("t-flip"), "any");
});

// Anything that isn't the literal string "program" is treated as open. A typo
// in programs.json should leave pixie answering, not silently mute her.
test("an unrecognised scope value falls back to any", () => {
  programs.saveProgram({ id: "t-typo", name: "Typo", scope: "programme" });
  programs.invalidate();
  assert.equal(programs.scope("t-typo"), "any");
});

test("the shared YSWS program is never scoped", () => {
  assert.equal(programs.shared().scope, "any");
  assert.equal(programs.isProgramScoped(programs.shared()), false);
  assert.equal(programs.scope(null), "any");
});
