const { test } = require("node:test");
const assert = require("node:assert/strict");
const sumThread = require("./sumThread");
const handlers = require("./handlers");
const { config } = require("./config");
const { readSource } = require("./test-source");

test("buildTranscript formats messages with proper sender tags", () => {
  const messages = [
    { user: "U123", text: "how do I flash the firmware?" },
    { bot_id: "B456", text: "you can run `make flash`" },
    { user: "U123", text: "got an error: permission denied" },
  ];

  const transcript = sumThread.buildTranscript(messages);
  assert.match(transcript, /<@U123>: how do I flash the firmware\?/);
  assert.match(transcript, /assistant \(bot\): you can run `make flash`/);
  assert.match(transcript, /<@U123>: got an error: permission denied/);
});

test("buildTranscript handles empty or textless messages safely", () => {
  const transcript = sumThread.buildTranscript([{ user: "U123" }, null, { text: "" }]);
  assert.equal(transcript, "");
});

test("sumPattern matches valid !sum triggers", () => {
  assert.equal(handlers.sumPattern().test("!sum"), true);
  assert.equal(handlers.sumPattern().test("!sum public"), true);
  assert.equal(handlers.sumPattern().test("!summary"), true);
  assert.equal(handlers.sumPattern().test("!summarize"), true);
  assert.equal(handlers.sumPattern().test("!summarise"), true);
  assert.equal(handlers.sumPattern().test("pixie-sum"), true);
  assert.equal(handlers.sumPattern().test("sum this"), true);
  assert.equal(handlers.sumPattern().test("sum thread"), true);
});

test("sumPattern ignores non-sum messages", () => {
  assert.equal(handlers.sumPattern().test("some other message"), false);
  assert.equal(handlers.sumPattern().test("what is the summary of rules"), false);
  assert.equal(handlers.sumPattern().test(""), false);
});

test("summarizeThreadForHelper returns null when thread has no messages", async () => {
  const mockClient = {
    conversations: {
      replies: async () => ({ messages: [] }),
    },
  };

  const result = await sumThread.summarizeThreadForHelper({
    client: mockClient,
    channel: "C123",
    threadTs: "100.1",
  });

  assert.equal(result, null);
});

test("sumThread output is a helper string or null — never a write", async () => {
  const fs = require("fs");
  const path = require("path");
  const src = readSource("sumThread.js");
  assert.equal(src.includes("postMessage"), false);
  assert.equal(src.includes("postEphemeral"), false);
  assert.equal(src.includes('require("./db")'), false);
  assert.equal(/INSERT\s+INTO/i.test(src), false);
  assert.equal(sumThread.THREAD_FETCH_LIMIT, 50);
  assert.match(sumThread.HELPER_SUMMARY_SYSTEM_PROMPT, /Asker/);
  assert.match(sumThread.HELPER_SUMMARY_SYSTEM_PROMPT, /Goal \/ Problem/);
  assert.match(sumThread.HELPER_SUMMARY_SYSTEM_PROMPT, /What Was Tried/);
  assert.match(sumThread.HELPER_SUMMARY_SYSTEM_PROMPT, /Current Status/);

  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => ({ text: "  • *Asker:* <@U1>\n• *Goal:* x  " });
  try {
    const out = await sumThread.summarizeThreadForHelper({
      client: {
        conversations: {
          replies: async (args: any) => {
            assert.equal(args.limit, 50);
            return { messages: [{ user: "U1", text: "my build fails" }] };
          },
        },
      },
      channel: "C1",
      threadTs: "char-sum-1",
    });
    assert.equal(typeof out, "string");
    assert.match(out, /Asker/);
  } finally {
    llm.complete = real;
  }
  llm.complete = async () => ({ text: "<thinking>draft</thinking>\n• *Asker:* <@U1>" });
  try {
    const stripped = await sumThread.summarizeThreadForHelper({
      client: { conversations: { replies: async () => ({ messages: [{ user: "U1", text: "hi" }] }) } },
      channel: "C1",
      threadTs: "char-sum-2",
    });
    assert.equal(stripped.includes("<thinking>"), false);
  } finally {
    llm.complete = real;
  }
  llm.complete = async () => ({ text: "   " });
  try {
    const none = await sumThread.summarizeThreadForHelper({
      client: { conversations: { replies: async () => ({ messages: [{ user: "U1", text: "hi" }] }) } },
      channel: "C1",
      threadTs: "char-sum-3",
    });
    assert.equal(none, null);
  } finally {
    llm.complete = real;
  }
});

test("registry: !sum writes nothing — no tickets, no helper pings, no learned knowledge", () => {
  const fs = require("fs");
  const path = require("path");
  const src = readSource("sumThread.js");
  assert.equal(src.includes('require("./db")'), false);
  assert.equal(src.includes('require("./tickets")'), false);
  assert.equal(src.includes("escalateTicket"), false);
  assert.equal(src.includes("addLearnedFact"), false);
  assert.equal(src.includes("captureFromThread"), false);
  assert.equal(src.includes("postMessage"), false);
  assert.equal(src.includes("postEphemeral"), false);
  const handlerSrc = readSource("handlers.js");
  const sumBlock = handlerSrc.slice(handlerSrc.indexOf("async function handleSumRequest"));
  const sumEnd = sumBlock.indexOf("async function onMessage");
  const sumFn = sumBlock.slice(0, sumEnd);
  assert.equal(sumFn.includes("escalateTicket"), false, "!sum must not open tickets");
  assert.equal(sumFn.includes("learn.teach"), false, "!sum must not write learned knowledge");
  assert.equal(sumFn.includes("captureFromThread"), false, "!sum must not queue pending facts");
});

test("sumThread scope is one thread per call — no cross-thread bleed", async () => {
  const llm = require("./llm");
  const real = llm.complete;
  let seenPrompt = "";
  llm.complete = async (args: any) => {
    seenPrompt = args.messages.map((m: any) => m.content).join("\n");
    return { text: "summary" };
  };
  try {
    const seen: any[] = [];
    const client = {
      conversations: {
        replies: async (args: any) => {
          seen.push(args);
          return { messages: [{ user: "U9", text: "only this thread" }] };
        },
      },
    };
    await sumThread.summarizeThreadForHelper({ client, channel: "C9", threadTs: "char-sum-scope" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].channel, "C9");
    assert.equal(seen[0].ts, "char-sum-scope");
    assert.match(seenPrompt, /only this thread/);
    assert.equal(seenPrompt.includes("another thread"), false);
  } finally {
    llm.complete = real;
  }
  assert.equal(sumThread.buildTranscript([]), "");
  assert.match(sumThread.buildTranscript([{ bot_id: "B1", text: "bot line" }]), /assistant \(bot\): bot line/);
});
export {};
