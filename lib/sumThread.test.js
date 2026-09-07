const { test } = require("node:test");
const assert = require("node:assert/strict");
const sumThread = require("./sumThread");
const handlers = require("./handlers");
const { config } = require("./config");

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
