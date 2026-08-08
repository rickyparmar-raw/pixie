process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const llm = require("./llm");
const guides = require("./guides");

db.open(":memory:");

// Guide selection falls back to the model when keywords miss. Stubbed to NONE so
// the suite stays hermetic and every assertion below is really testing the free
// keyword pass; the tests that care about the fallback set it themselves.
let modelChoice = "NONE";
// llm is a shared, cached module — every test file `require("./llm")`s the
// same exports object. Stubbing at require time (module top level) poisons it
// during Bun's collection phase, before any file's tests have run at all, so
// before()/after() bracket the stub around this file's own execution window
// instead — anything outside that window sees the real llm.complete.
let realComplete;
before(() => {
  realComplete = llm.complete;
  llm.complete = async () => ({ text: modelChoice, finishReason: "stop" });
});
after(() => {
  llm.complete = realComplete;
});

test("detectGuideIntent matches each guide's trigger phrasing", async () => {
  assert.equal(await guides.detectGuideIntent("how do i unlock the next region"), "next-region");
  assert.equal(await guides.detectGuideIntent("help me unlock a new region pls"), "next-region");
  assert.equal(await guides.detectGuideIntent("can you walk me through git setup"), "git-setup");
  assert.equal(await guides.detectGuideIntent("how do i set up hackatime tracking"), "hackatime");
});

// The message that proved the old substring match was too brittle: recorded as
// doc_gap 79 instead of starting the walkthrough it was asking for.
test("detectGuideByKeyword survives a typo in the guide's subject", () => {
  assert.equal(guides.detectGuideByKeyword("pixie help me setup hackatimm"), "hackatime");
  assert.equal(guides.detectGuideByKeyword("how do i unlock the next regoin"), "next-region");
});

// Budget is length-scaled precisely so short words stay exact — "get" must not
// reach "git", or every "how do i get X" starts a git walkthrough.
test("detectGuideByKeyword does not fuzzy-match short words into a guide", () => {
  assert.equal(guides.detectGuideByKeyword("how do i get set up with pixl"), null);
});

// Naming the topic isn't asking to be walked through it.
test("detectGuideByKeyword needs both the subject and an intent hint", () => {
  assert.equal(guides.detectGuideByKeyword("hackatime is down again"), null);
  assert.equal(guides.detectGuideByKeyword("which region are you in"), null);
});

test("detectGuideIntent returns null for unrelated messages", async () => {
  assert.equal(await guides.detectGuideIntent("whats the deadline"), null);
  assert.equal(await guides.detectGuideIntent(""), null);
  assert.equal(await guides.detectGuideIntent(undefined), null);
});

// Keywords can't cover every phrasing, so a help request that misses them gets
// one model call to decide.
test("detectGuideIntent falls back to the model on a keyword miss", async () => {
  modelChoice = "hackatime";
  assert.equal(await guides.detectGuideIntent("how do i make my coding hours count for this?"), "hackatime");
  modelChoice = "NONE";
});

// Small talk must never reach the fallback — that's the gate that keeps chat
// from paying for a network call.
test("detectGuideIntent skips the model for messages that aren't help requests", async () => {
  modelChoice = "git-setup";
  assert.equal(await guides.detectGuideIntent("lol same"), null);
  modelChoice = "NONE";
});

test("startGuide returns the first step and records state", () => {
  const result = guides.startGuide("git-setup", "thread-a", "U1");
  assert.match(result.message, /git --version/);
  assert.ok(result.checkNext);
  assert.equal(guides.isInGuide("thread-a"), true);
});

test("startGuide rejects an unknown guide id", () => {
  assert.equal(guides.startGuide("does-not-exist", "thread-x", "U1"), null);
});

test("continueGuide returns null when no guide is active", async () => {
  assert.equal(await guides.continueGuide("thread-never-started", "yes"), null);
});

// Exit is checked before the model call, so bailing out is free and can't be
// broken by an API outage.
test("isExitRequest recognises the ways people actually quit", () => {
  for (const phrase of ["stop", "nvm", "nevermind", "cancel", "forget it", "  quit "]) {
    assert.equal(guides.isExitRequest(phrase), true, phrase);
  }
});

test("isExitRequest ignores normal step replies", () => {
  for (const phrase of ["yes", "it shows 2.39.2", "no it says command not found", ""]) {
    assert.equal(guides.isExitRequest(phrase), false, phrase);
  }
});

test("continueGuide cancels without an API call when the user bails", async () => {
  guides.startGuide("hackatime", "thread-b", "U1");
  const result = await guides.continueGuide("thread-b", "nvm");

  assert.equal(result.cancelled, true);
  assert.equal(guides.isInGuide("thread-b"), false);
});

test("cancelGuide clears an active guide", () => {
  guides.startGuide("next-region", "thread-c", "U1");
  guides.cancelGuide("thread-c");
  assert.equal(guides.isInGuide("thread-c"), false);
});

test("classifierPrompt enumerates every alternate branch as its own label", () => {
  const guide = guides.GUIDES["git-setup"];
  const keys = Object.keys(guide.alternateSteps);
  const prompt = guides.classifierPrompt(guide, guide.steps[0], keys);

  assert.match(prompt, /STUCK_1:/);
  assert.match(prompt, /STUCK_2:/);
  assert.match(prompt, /ADVANCE:/);
  assert.match(prompt, /OTHER:/);
  // The branch descriptions are natural language, not literal phrases the user
  // has to type.
  assert.match(prompt, /command not found/);
});

// The model pass used to run on every help-shaped message the keyword pass
// missed — ~1700ms in front of the answer call, returning NONE nearly every
// time. A message that names no guide subject has no guide to choose.
test("detectGuideIntent skips the model when no guide subject is mentioned", async () => {
  modelChoice = "git-setup";
  assert.equal(await guides.detectGuideIntent("how do i fix a 404 on my deployed site?"), null);
  assert.equal(await guides.detectGuideIntent("my sprite wont load at all, what should i do?"), null);
  modelChoice = "NONE";
});

// The subject match is fuzzy for the same reason the keyword pass is: one typo
// used to kill guide detection outright.
test("mentionsGuideSubject survives a typo and ignores unrelated messages", () => {
  assert.equal(guides.mentionsGuideSubject("pixie help me setup hackatimm"), true);
  assert.equal(guides.mentionsGuideSubject("how do i make my coding hours count for this?"), true);
  assert.equal(guides.mentionsGuideSubject("whats the deadline"), false);
  assert.equal(guides.mentionsGuideSubject(""), false);
});
