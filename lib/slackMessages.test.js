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

test("Pixl's branding can never appear on a message sent for a different program", async () => {
  const sentPayloads = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        sentPayloads.push(payload);
        return { ts: "9.0" };
      },
    },
  };

  const pixl = { id: "pixl", name: "Pixl", supportName: "Pixl Help", iconUrl: "https://cdn.example.com/pixl.png" };
  const sandbox = { id: "pixie-sandbox-e2e", name: "Sandbox", supportName: "Sandbox Help", iconUrl: "https://cdn.example.com/sandbox.png" };

  await sendProgramMessage({ client, program: pixl, channel: "C-PIXL", text: "pixl answer" });
  await sendProgramMessage({ client, program: sandbox, channel: "C-SANDBOX", text: "sandbox answer" });

  const [pixlPayload, sandboxPayload] = sentPayloads;
  assert.equal(pixlPayload.username, "Pixl Help");
  assert.equal(sandboxPayload.username, "Sandbox Help");
  assert.notEqual(pixlPayload.username, sandboxPayload.username);
  assert.notEqual(pixlPayload.icon_url, sandboxPayload.icon_url);
  // The Pixl identity must not leak onto the sandbox program's message in
  // any field, not just username.
  assert.equal(JSON.stringify(sandboxPayload).includes("Pixl"), false);
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
