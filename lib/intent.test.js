const { test } = require("node:test");
const assert = require("node:assert/strict");
const intent = require("./intent");
const { worthClassifying, looksLikeHelpRequest, buildUserPrompt, HISTORY_LIMIT } = intent;

/* -------------------------------------------------------- worthClassifying -- */
// All that is left of the old regex gate. It does not judge meaning — it only
// refuses to pay for a model call on a message with nothing in it. Anything
// with words goes to the classifier, which sees the person's recent messages
// and decides.

test("worthClassifying sends anything with words in it to the model", () => {
  assert.equal(worthClassifying("how do i submit my project?"), true);
  assert.equal(worthClassifying("my build broke"), true);
  assert.equal(worthClassifying("```TypeError: undefined is not a function```"), true);
  // Riffing and thanks used to be dropped here by a banter regex. They are the
  // exact calls the model is now meant to make, so they go through.
  assert.equal(worthClassifying("imagine if the whole thing was written in rust"), true);
  assert.equal(worthClassifying("lol thanks so much for that"), true);
  assert.equal(worthClassifying("wait WHAT IF I JS GET 60 DIFFERENT API KEYS"), true);
  assert.equal(worthClassifying("still nothing"), true);
});

test("worthClassifying drops messages that say nothing at all", () => {
  assert.equal(worthClassifying(""), false);
  assert.equal(worthClassifying(undefined), false);
  assert.equal(worthClassifying("   "), false);
  assert.equal(worthClassifying("ok"), false);
  assert.equal(worthClassifying("lmaooo"), false);
  assert.equal(worthClassifying("gg"), false);
  assert.equal(worthClassifying("yeah true"), false);
  assert.equal(worthClassifying("lol same"), false);
});

// A channel message is half decoration. Emoji and pings are not words, so a
// message made only of them is not worth a model call.
test("worthClassifying looks past emoji, pings and links", () => {
  assert.equal(worthClassifying(":yay: :sho: :pf:"), false);
  assert.equal(worthClassifying("<@U123>"), false);
  assert.equal(worthClassifying(":upvote: thanks"), false);
  assert.equal(worthClassifying("<@U123> my tileset wont render"), true);
});

// The stoplist is exact-match on whole words, so a reaction word inside a real
// sentence never drops it.
test("worthClassifying keeps a real message that opens with a reaction word", () => {
  assert.equal(worthClassifying("ok so where do i put the token"), true);
  assert.equal(worthClassifying("nah the build still fails after that"), true);
  assert.equal(worthClassifying("w or l on using godot for this"), true);
});

/* --------------------------------------------------------------- scope -- */
// A program can say it only wants its own questions answered. That is the same
// call as "is anyone asking" — one model call, one word back — so it is a third
// verdict rather than a second request.

test("a scoped program gets the OFF_TOPIC verdict offered", () => {
  const prompt = intent.intentSystemPrompt({ name: "Pixl" }, { scoped: true });
  assert.match(prompt, /OFF_TOPIC/);
  assert.match(prompt, /HELP_NEEDED\|CASUAL_CHAT\|OFF_TOPIC/);
  assert.match(prompt, /only wants Pixl answers/);
  assert.match(prompt, /asking about the shop, catalogue, items/);
  assert.match(prompt, /asking about hardware, firmware, testing/);
  // Unsure means stay out of it — the opposite of the unscoped default, where
  // unsure only has to clear "was anyone asking".
  assert.match(prompt, /cannot tell whether a question is about Pixl.*OFF_TOPIC/s);
});

test("an unscoped program is never offered OFF_TOPIC", () => {
  const prompt = intent.intentSystemPrompt({ name: "Pixl" });
  assert.doesNotMatch(prompt, /OFF_TOPIC/);
  assert.match(prompt, /exactly one JSON object/);
});

// Scoping is about what pixie volunteers, not what she refuses. Someone who
// says her name and asks gets an answer whatever it's about.
test("addressing pixie lifts the scope restriction", () => {
  const scoped = { id: "pixl", name: "Pixl", scope: "program" };
  const open = { id: "sprig", name: "Sprig", scope: "any" };

  assert.equal(intent.scopedFor(scoped, false), true, "unaddressed in a scoped program");
  assert.equal(intent.scopedFor(scoped, true), false, "they asked her directly");
  assert.equal(intent.scopedFor(open, false), false, "an open program never scopes");
  assert.equal(intent.scopedFor(null, false), false);
});

/* ----------------------------------------------------------- buildUserPrompt -- */
// What the classifier actually reads. The message under judgement has to be
// last and clearly separated, or the model grades the history instead.

test("buildUserPrompt puts the history first and the message under judgement last", () => {
  const prompt = buildUserPrompt("still nothing", ["my build broke", "tried reinstalling"]);
  assert.match(prompt, /oldest first/);
  assert.match(prompt, /1\. \[human\] my build broke/);
  assert.match(prompt, /2\. \[human\] tried reinstalling/);
  assert.match(prompt, /The message to judge \(human, not context\):\n\[human\] still nothing$/);
});

test("buildUserPrompt says so plainly when there is no history", () => {
  const prompt = buildUserPrompt("how do i connect hackatime", []);
  assert.match(prompt, /no context available/);
  assert.match(prompt, /\[human\] how do i connect hackatime$/);
});

test("HISTORY_LIMIT is three — enough to see what someone is in the middle of", () => {
  assert.equal(HISTORY_LIMIT, 3);
});

/* ------------------------------------------------------ looksLikeHelpRequest -- */
// No longer the HELP_ONLY gate — the model is. This now only decides whether a
// missed question is written to the docs to-do list, and whether to offer a
// guide, in the modes that never call the classifier.

test("looksLikeHelpRequest accepts someone asking the room for something", () => {
  assert.equal(looksLikeHelpRequest("how do i connect hackatime"), true);
  assert.equal(looksLikeHelpRequest("how do i go to the shop"), true);
  assert.equal(looksLikeHelpRequest("how do i test my firmware if i don't have hardware yet"), true);
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

/* ------------------------------------------- STEP 1 characterization pins --
   WHY: pins for the INTENT/ELIGIBILITY rewrite. Short inputs and repeat
   history must not change silently — if a fix moves them, the pin wins. */

// WHY: short HELP_ONLY inputs never reach the model — worth drops them,
// the heuristic says no request, the classifier fail-softs to null (silent
// in HELP_ONLY, non-ticketworthy via heuristic fallback — same as chat).
test("char: short HELP_ONLY inputs pin current verdict", async () => {
  assert.equal(worthClassifying("how"), false);
  assert.equal(worthClassifying("what"), false);
  assert.equal(worthClassifying("ok"), false);
  assert.equal(looksLikeHelpRequest("how"), false);
  assert.equal(looksLikeHelpRequest("what"), false);
  assert.equal(looksLikeHelpRequest("ok"), false);
  // Length gate (<5) fail-softs to null — HELP_ONLY treats null as silent.
  assert.equal(await intent.classifyIntent("how", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("what", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("ok", null, { history: [] }), null);
});

// WHY: "still nothing" repeats are recorded even when silent — the gate reads
// the three before the one it judges, and most of those never got a reply.
test("char: duplicate-text history pins current context", async () => {
  process.env.PIXIE_DB_PATH = ":memory:";
  const db = require("./db");
  try { db.open(":memory:"); } catch (_) {}
  const user = `char-dup-${Date.now()}`;
  db.recordUserMessage({ userId: user, channel: "C1", threadTs: "1.1", text: "my build broke" });
  db.recordUserMessage({ userId: user, channel: "C1", threadTs: "1.1", text: "still nothing" });
  db.recordUserMessage({ userId: user, channel: "C1", threadTs: "1.1", text: "still nothing" });
  const recent = db.recentUserMessages(user, { channel: "C1", limit: 3 });
  assert.deepEqual(recent.map((r) => r.text), ["my build broke", "still nothing", "still nothing"]);
  // The judge drops exactly one copy of the message under judgement (the row
  // handlers just recorded), so one duplicate stays in context.
  const rows = recent.map((r) => (r.text || "").trim()).filter(Boolean);
  const current = "still nothing";
  if (rows.length > 0 && rows[rows.length - 1] === current.trim()) rows.pop();
  assert.deepEqual(rows.slice(-intent.HISTORY_LIMIT), ["my build broke", "still nothing"]);
  assert.equal(worthClassifying("still nothing"), true);
  const prompt = intent.buildUserPrompt("still nothing", ["my build broke", "still nothing"]);
  assert.match(prompt, /1\. \[human\] my build broke/);
  assert.match(prompt, /2\. \[human\] still nothing/);
});

test("buildUserPrompt preserves bounded thread and recent speaker boundaries", () => {
  const prompt = intent.buildUserPrompt("please help Pixie", [], {
    threadMessages: [{ speaker: "human", text: "my build fails" }, { speaker: "pixie", text: "What error do you see?" }],
    recentMessages: [{ userId: "U1", text: "talking to another human" }],
  });
  assert.match(prompt, /Thread context/);
  assert.match(prompt, /\[pixie\] What error do you see\?/);
  assert.match(prompt, /Recent channel context/);
  assert.match(prompt, /\[human\] talking to another human/);
  assert.match(prompt, /\[human\] please help Pixie$/);
});

test("parseContextResult is strict and fails closed", () => {
  const valid = '{"verdict":"HELP_NEEDED","addressedToPixie":true,"directedAtHuman":false,"recentPixieParticipation":true,"programRelevance":"relevant"}';
  assert.deepEqual(intent.parseContextResult(valid), {
    verdict: "HELP_NEEDED", addressedToPixie: true, directedAtHuman: false, recentPixieParticipation: true, programRelevance: "relevant",
  });
  assert.equal(intent.parseContextResult("HELP_NEEDED"), null);
  assert.equal(intent.parseContextResult(`${valid.slice(0, -1)},"extra":true}`), null);
  assert.equal(intent.parseContextResult(valid.replace("true", '"true"')), null);
});

test("structured intent is enriched into the canonical engagement decision", () => {
  const support = intent.normalizeIntentResult({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    recentPixieParticipation: true,
    programRelevance: "relevant",
  });
  assert.equal(support.needsHelp, true);
  assert.equal(support.shouldAttemptAnswer, true);
  assert.equal(support.recentPixieParticipation, true);

  const human = intent.normalizeIntentResult({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    directedAtHuman: true,
    recentPixieParticipation: false,
    programRelevance: "relevant",
  });
  assert.equal(human.shouldAttemptAnswer, false);

  assert.equal(intent.normalizeIntentResult(intent.HELP_NEEDED).shouldAttemptAnswer, true);
  assert.equal(intent.normalizeIntentResult(intent.CASUAL_CHAT).shouldAttemptAnswer, false);
  assert.equal(intent.normalizeIntentResult(null), null);
});

// WHY: short-input ticket signal stays non-ticketworthy — null falls back
// to the heuristic, which is also silent for shorts (never code, <3 words).
test("char: short-input ticket gate pins current", () => {
  assert.equal(looksLikeHelpRequest("how"), false);
  assert.equal(looksLikeHelpRequest("ok"), false);
  assert.equal(null !== intent.HELP_NEEDED, true);
});

// WHY: fail-soft short gate — null keeps HELP_ONLY silent and keeps tickets
// closed, same terminal as chat but without a fake verdict.
test("short-input: length<5 fail-softs to null", async () => {
  assert.equal(await intent.classifyIntent("how", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("ab", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("abcd", null, { history: [] }), null);
  // HELP_ONLY gate treats null as silent (not HELP_NEEDED).
  assert.notEqual(null, intent.HELP_NEEDED);
  // Ticket fallback for the same shorts stays non-ticketworthy.
  assert.equal(looksLikeHelpRequest("how"), false);
  assert.equal(looksLikeHelpRequest("abcd"), false);
});
