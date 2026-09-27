const { test } = require("node:test");
const assert = require("node:assert/strict");
const answer = require("./answer");
const llm = require("./llm");

test("normalizeEmoji converts markdown emphasis", () => {
  assert.equal(answer.normalizeEmoji("**ready** and __set__"), "*ready* and _set_");
});

test("normalizeEmoji leaves ordinary channel text generic", () => {
  assert.equal(answer.normalizeEmoji("ask in the help channel"), "ask in the help channel");
});

test("parseReply extracts a source and answer", () => {
  assert.deepEqual(answer.parseReply("SOURCE: Example docs\nANSWER: follow the setup steps"), {
    source: "Example docs",
    answer: "follow the setup steps",
  });
  assert.deepEqual(answer.parseReply("SOURCE: NONE\nANSWER: UNCLEAR"), { source: "NONE", answer: "UNCLEAR" });
});

test("parseReply rejects empty and instruction-like output", () => {
  assert.equal(answer.parseReply(""), null);
  assert.equal(answer.parseReply("SOURCE: Example\nANSWER: output only the final answer"), null);
});

test("parseAnswerOrChat keeps ordinary conversational replies ungrounded", () => {
  assert.deepEqual(answer.parseAnswerOrChat("not much, just vibing :sparkles:"), {
    source: null,
    answer: "not much, just vibing :sparkles:",
  });
});

test("the unclear marker produces no answer", () => {
  assert.deepEqual(answer.parseAnswerOrChat("SOURCE: NONE\nANSWER: UNCLEAR"), {
    source: null,
    answer: "",
    unclear: true,
  });
});

test("program prompts use configured identity and timeline metadata", () => {
  const program = { id: "demo", name: "Demo", helpChannel: "C_HELP", scope: "program" };
  const prompt = answer.answerOrChatPrompt("### Demo docs\nA rule", "", false, program, "C_HELP");
  assert.match(prompt, /WHERE YOU ARE: <#C_HELP>/);
  assert.match(prompt, /Demo/);
  assert.match(prompt, /Program timeline/);
});

test("generic guardrails point to configured help without inventing program facts", () => {
  const guardrail = answer.programGuardrail({ id: "acme", name: "Acme", helpChannel: "C_HELP" }, false);
  assert.match(guardrail, /Acme/);
  assert.match(guardrail, /<\#C_HELP>/);
  assert.match(guardrail, /Never invent/);
});

test("whereYouAre distinguishes owned and unowned channels", () => {
  const owned = answer.whereYouAre({ id: "demo", name: "Demo", helpChannel: "C_HELP" }, "C_HELP");
  assert.match(owned, /every question here is about Demo/);
  assert.match(owned, /redirect to any other/);

  const unowned = answer.whereYouAre(null, "C_RANDOM");
  assert.match(unowned, /isn't tied to any one/);
});

test("stream parsing emits only answer text", async () => {
  const original = llm.completeStream;
  llm.completeStream = async (_options: unknown, onDelta: (delta: string, text: string) => void) => {
    const text = "SOURCE: Example docs\nANSWER: use the configured docs :sparkles:";
    onDelta(text, text);
    return { text, stopped: false };
  };
  try {
    const seen: string[] = [];
    const result = await answer.getAnswerOrChatStream("how do I start", "### Example docs\nsetup", "", {
      onText: (text: string) => seen.push(text),
    });
    assert.deepEqual(result, { source: "Example docs", answer: "use the configured docs :sparkles:" });
    assert.deepEqual(seen, ["use the configured docs :sparkles:"]);
  } finally {
    llm.completeStream = original;
  }
});

export {};
