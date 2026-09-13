// Prompt parity: freeze prompt wording without changing any source.
//
// No source changes here or in lib/answer.js (`git diff lib/answer.js` must
// stay empty). Every assertion below pins a required clause present in the
// current prompts, or forbidden content absent from them, across
// grounded/ungrounded x named-program/unnamed-program x help-channel/not.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const answer = require("./answer");
const programs = require("./programs");

const NAMED = { id: "pixl", name: "Pixl", helpChannel: "C-help" };
const NAMED_GROUNDED = { ...NAMED, requireGroundedAnswer: true };

function withGroundedEnv(fn) {
  const prev = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
  process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = "1";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
    else process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = prev;
  }
}

/* ------------------------------------------------------- whereYouAre verbatim -- */

test("PARITY: whereYouAre help-channel lines pinned verbatim", () => {
  const block = answer.whereYouAre(NAMED, "C-help");
  assert.ok(block.includes("WHERE YOU ARE: <#C-help> — the help channel for Pixl, a Hack Club YSWS program."));
  assert.ok(
    block.includes(
      `Unless somebody names a different program, every question here is about Pixl. "the deadline", "the docs", "when does it launch", "how do i submit", "is it out yet" all mean Pixl's.`,
    ),
  );
  assert.ok(
    block.includes(
      `This is a Pixl channel only. Do not mention, suggest, or redirect to any other Hack Club program or YSWS unless the person explicitly writes that other program's name themselves. A word that merely sounds like another program's name is still a Pixl question.`,
    ),
  );
});

test("PARITY: whereYouAre non-help channel role line pinned verbatim", () => {
  const block = answer.whereYouAre(NAMED, "C-chat");
  assert.ok(block.includes("WHERE YOU ARE: <#C-chat> — one of the channels for Pixl, a Hack Club YSWS program."));
  assert.doesNotMatch(block, /the help channel for Pixl/);
});

test("PARITY: whereYouAre unnamed-channel disambiguation lines pinned verbatim", () => {
  const block = answer.whereYouAre(null, "C-random");
  assert.ok(block.includes("WHERE YOU ARE: <#C-random> — a channel that isn't tied to any one YSWS program."));
  assert.ok(
    block.includes(
      "Don't assume which program someone means. If a question only makes sense for a specific program and they haven't said which one, ask them which.",
    ),
  );
});

/* ------------------------------------------------------- systemPrompt ungrounded -- */

test("PARITY: systemPrompt (ungrounded, named) carries every required clause", () => {
  const prompt = answer.systemPrompt("corpus", "", NAMED, "C-help");
  assert.match(prompt, /WHERE YOU ARE: <#C-help>/);
  assert.match(prompt, /every question here is about Pixl/);
  assert.match(prompt, /chill teenager/); // voice rules
  assert.match(prompt, /never use dashes/);
  assert.match(prompt, /SOURCE: section name from docs/); // CASE format
  assert.match(prompt, /ANSWER: your short, casual answer/);
  assert.match(prompt, /reply with exactly: NONE/); // NONE marker
  assert.match(prompt, /Program timeline.*authority ONLY/); // timeline authority
  assert.match(prompt, /must never trigger this rule on its own/);
  assert.match(prompt, /only source of reward thresholds/); // shop authority
  assert.match(prompt, /DOMAIN SPECIFICITY/); // domain specificity
  assert.match(prompt, /STRICT SCENARIO FOCUS/); // scenario focus
  assert.match(prompt, /dedicated help channel/); // ungrounded help-channel ref
  assert.match(prompt, /=== DOCUMENTATION ===/);
  assert.match(prompt, /CRITICAL REMINDER/);
});

test("PARITY: systemPrompt (ungrounded, unnamed, not-help) keeps disambiguation + voice + format", () => {
  const prompt = answer.systemPrompt("corpus", "", null, "C-random");
  assert.match(prompt, /isn't tied to any one YSWS program/);
  assert.match(prompt, /ask them which/);
  assert.match(prompt, /chill teenager/);
  assert.match(prompt, /SOURCE: section name from docs/);
  assert.match(prompt, /STRICT SCENARIO FOCUS/);
  assert.match(prompt, /DOMAIN SPECIFICITY/);
});

/* ------------------------------------------------------- systemPrompt grounded -- */

test("PARITY: systemPrompt (grounded, named) has the no-channel rule and no redirect", () => {
  const prompt = answer.systemPrompt("corpus", "", NAMED_GROUNDED, "C-help");
  assert.match(prompt, /STRICT 1:1 GROUNDING/);
  assert.match(prompt, /NEVER mention, link, or suggest any Slack channels/);
  assert.match(prompt, /Never redirect users to other channels/);
  assert.match(prompt, /reply with: NONE/);
  assert.doesNotMatch(prompt, /dedicated help channel/);
  assert.doesNotMatch(prompt, /point them at <#/);
  assert.doesNotMatch(prompt, /a helper in this channel will pick it up/);
});

test("PARITY: systemPrompt grounded via env pins the same no-channel rule", () => {
  withGroundedEnv(() => {
    const prompt = answer.systemPrompt("corpus", "", null, "C-random");
    assert.match(prompt, /STRICT 1:1 GROUNDING/);
    assert.doesNotMatch(prompt, /dedicated help channel/);
    // Grounded unnamed lists no sibling programs.
    assert.doesNotMatch(prompt, /Hack Club runs several YSWS programs/);
  });
});

/* ------------------------------------------------------- answerOrChatPrompt matrix -- */

test("PARITY: answerOrChatPrompt matrix — CASE format + markers in every cell", () => {
  const cells = [
    ["ungrounded", "named", "not-help", answer.answerOrChatPrompt("corpus", "", false, NAMED, "C-chat")],
    ["ungrounded", "named", "help", answer.answerOrChatPrompt("corpus", "", true, NAMED, "C-help")],
    ["ungrounded", "unnamed", "not-help", answer.answerOrChatPrompt("corpus", "", false, null, "C-random")],
    ["ungrounded", "unnamed", "help", answer.answerOrChatPrompt("corpus", "", true, null, "C-random")],
    ["grounded", "named", "not-help", answer.answerOrChatPrompt("corpus", "", false, NAMED_GROUNDED, "C-chat")],
    ["grounded", "named", "help", answer.answerOrChatPrompt("corpus", "", true, NAMED_GROUNDED, "C-help")],
  ];
  for (const [grounded, named, help, prompt] of cells) {
    assert.match(prompt, /CASE 1/, `${grounded}/${named}/${help} has CASE 1`);
    assert.match(prompt, /CASE 2/, `${grounded}/${named}/${help} has CASE 2`);
    assert.match(prompt, /SOURCE:/, `${grounded}/${named}/${help} has SOURCE:`);
    assert.match(prompt, /ANSWER:/, `${grounded}/${named}/${help} has ANSWER:`);
    assert.match(prompt, /SOURCE: NONE/, `${grounded}/${named}/${help} has NONE marker`);
    assert.match(prompt, /Program timeline/, `${grounded}/${named}/${help} has timeline rule`);
    assert.match(prompt, /only source of reward thresholds/, `${grounded}/${named}/${help} has shop rule`);
    assert.match(prompt, /DOMAIN SPECIFICITY/, `${grounded}/${named}/${help} has domain rule`);
    assert.match(prompt, /STRICT SCENARIO FOCUS/, `${grounded}/${named}/${help} has scenario rule`);
    assert.match(prompt, /CRITICAL REMINDER/, `${grounded}/${named}/${help} has closing reminder`);
  }
});

test("PARITY: answerOrChatPrompt ungrounded carries UNCLEAR + help-channel redirect variants", () => {
  const notHelp = answer.answerOrChatPrompt("corpus", "", false, NAMED, "C-chat");
  const inHelp = answer.answerOrChatPrompt("corpus", "", true, NAMED, "C-help");
  for (const prompt of [notHelp, inHelp]) {
    assert.match(prompt, new RegExp(`ANSWER: ${answer.UNCLEAR_MARKER}`));
    assert.match(prompt, /cannot tell what they.re asking about/i);
  }
  assert.match(notHelp, /point them at <#/);
  assert.match(inHelp, /a helper in this channel will pick it up/);
});

test("PARITY: answerOrChatPrompt grounded pins CASE-2-exactness + no-channel rule", () => {
  for (const inHelp of [false, true]) {
    const prompt = answer.answerOrChatPrompt("corpus", "", inHelp, NAMED_GROUNDED, inHelp ? "C-help" : "C-chat");
    assert.ok(prompt.includes(`Output exactly:\nSOURCE: NONE\nANSWER: ${answer.UNCLEAR_MARKER}`));
    assert.match(prompt, /NEVER mention, link, or suggest ANY Slack channels/);
    assert.match(prompt, /always output CASE 2/);
    assert.match(prompt, /Greetings, small talk, and anything not factually in the docs are CASE 2/);
    assert.doesNotMatch(prompt, /point them at <#/);
    assert.doesNotMatch(prompt, /a helper in this channel will pick it up/);
  }
});

/* ------------------------------------------------------- forbidden leakage -- */

test("PARITY: named prompts never leak other programs or their pinned rules", () => {
  const pixl = programs.get("pixl");
  const b2b = programs.get("back-to-basics");
  const pixlPrompts = [
    answer.systemPrompt("corpus", "", pixl, "C-help"),
    answer.answerOrChatPrompt("corpus", "", false, pixl, "C-chat"),
    answer.answerOrChatPrompt("corpus", "", false, { ...pixl, requireGroundedAnswer: true }, "C-chat"),
  ];
  for (const prompt of pixlPrompts) {
    assert.doesNotMatch(prompt, /Hardwire/);
    assert.doesNotMatch(prompt, /point them at that program's channel/);
    assert.doesNotMatch(prompt, /Hack Club runs several YSWS programs/);
  }
  const b2bPrompts = [
    answer.systemPrompt("corpus", "", b2b, "C-b2b"),
    answer.answerOrChatPrompt("corpus", "", false, b2b, "C-b2b"),
    answer.answerOrChatPrompt("corpus", "", false, { ...b2b, requireGroundedAnswer: true }, "C-b2b"),
  ];
  for (const prompt of b2bPrompts) {
    assert.doesNotMatch(prompt, /30% AI POLICY/);
    assert.doesNotMatch(prompt, /REFERRAL CODES/);
    assert.doesNotMatch(prompt, /100% original CAD/i);
    assert.doesNotMatch(prompt, /reduced-hour approvals/);
    // The generic anti-blending rule still applies everywhere.
    assert.match(prompt, /STRICT SCENARIO FOCUS/);
  }
});

test("PARITY: grounded prompts never carry channel redirects", () => {
  const prompts = [
    answer.systemPrompt("corpus", "", NAMED_GROUNDED, "C-help"),
    answer.answerOrChatPrompt("corpus", "", false, NAMED_GROUNDED, "C-chat"),
    answer.answerOrChatPrompt("corpus", "", true, NAMED_GROUNDED, "C-help"),
  ];
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /point them at <#/);
    assert.doesNotMatch(prompt, /use <#.*instead — that's this program's dedicated help channel/);
    assert.doesNotMatch(prompt, /a helper in this channel will pick it up/);
  }
});
