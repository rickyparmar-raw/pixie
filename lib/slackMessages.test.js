const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sendProgramMessage, brandingFor } = require("./slackMessages");

test("branding uses the program support identity, never a human", () => {
  const brand = brandingFor({ name: "Highway", supportName: "Highway Help", iconUrl: "https://example.com/i.png" });
  assert.equal(brand.username, "Highway Help");
  assert.equal(brand.icon_url, "https://example.com/i.png");
  assert.equal(brandingFor(null).username, undefined);
});

test("message sends with branding, falls back when customization is rejected", async () => {
  const sent = [];
  const picky = {
    chat: {
      postMessage: async (payload) => {
        sent.push(payload);
        if (payload.username) {
          const err = new Error("missing_scope");
          err.code = "missing_scope";
          throw err;
        }
        return { ts: "1.0" };
      },
    },
  };
  const res = await sendProgramMessage({
    client: picky,
    program: { name: "Highway", supportName: "Highway Help" },
    channel: "C1",
    threadTs: "1.0",
    text: "hello",
  });
  assert.equal(res.ts, "1.0");
  assert.equal(sent.length, 2);
  assert.ok(sent[0].username);
  assert.equal(sent[1].username, undefined);
});

test("permanent Slack errors are not retried forever", async () => {
  let calls = 0;
  const dead = {
    chat: {
      postMessage: async () => {
        calls += 1;
        const err = new Error("not_in_channel");
        err.code = "not_in_channel";
        throw err;
      },
    },
  };
  await assert.rejects(() => sendProgramMessage({ client: dead, channel: "C1", text: "hi" }), /not_in_channel/);
  assert.equal(calls, 1);
});

test("429 with Retry-After is honored once, then the send succeeds", async () => {
  let calls = 0;
  const flaky = {
    chat: {
      postMessage: async (payload) => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("ratelimited");
          err.code = "slack_error";
          err.retryAfter = 0;
          err.data = { error: "ratelimited" };
          throw err;
        }
        return { ts: "3.0", payload };
      },
    },
  };
  const res = await sendProgramMessage({ client: flaky, channel: "C1", text: "hi" });
  assert.equal(res.ts, "3.0");
  assert.equal(calls, 2);
});
