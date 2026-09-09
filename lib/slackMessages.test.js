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

// WHY: the cap must be proven without waiting 30s in the suite.
async function withCapturedSleeps(fn) {
  const delays = [];
  const orig = global.setTimeout;
  global.setTimeout = (cb, ms, ...rest) => {
    delays.push(ms);
    cb();
    return 0;
  };
  try {
    const out = await fn();
    return { out, delays };
  } finally {
    global.setTimeout = orig;
  }
}

test("characterization: shadow mode returns fixed shape and sends nothing", async () => {
  // WHY: callers branch on the exact shape, so it is pinned not unified.
  let called = false;
  const client = { chat: { postMessage: async () => { called = true; return { ts: "x" }; } } };
  const res = await sendProgramMessage({ client, program: { id: "p1", shadowMode: true }, channel: "C1", text: "hi" });
  assert.deepEqual(res, { ok: false, shadowed: true, ts: null });
  assert.equal(called, false);
});

test("characterization: brandingFor trims supportName and drops empty", () => {
  // WHY: pinned bug now fixed, so the pin asserts the fixed shape.
  const cases = [
    [{ supportName: "  Highway Help  " }, "Highway Help"],
    [{ supportName: "a".repeat(100) }, "a".repeat(80)],
    [{ supportName: "   " }, undefined],
  ];
  for (const [prog, want] of cases) assert.equal(brandingFor(prog).username, want);
});

test("characterization: brandingFor keeps only http(s) icons", () => {
  // WHY: pinned bug now fixed, so the pin asserts the fixed shape.
  const cases = [
    [{ name: "H" }, undefined],
    [{ name: "H", iconUrl: "not-a-url" }, undefined],
    [{ name: "H", iconUrl: "ftp://example.com/i.png" }, undefined],
    [{ name: "H", iconUrl: "https://example.com/i.png" }, "https://example.com/i.png"],
  ];
  for (const [prog, want] of cases) assert.equal(brandingFor(prog).icon_url, want);
});

test("characterization: send validation rejects missing channel/text/client", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "x" }) } };
  await assert.rejects(() => sendProgramMessage({ client, channel: "", text: "hi" }), /channel required/);
  await assert.rejects(() => sendProgramMessage({ client, channel: "C1" }), /text or blocks required/);
  await assert.rejects(() => sendProgramMessage({ client: null, channel: "C1", text: "hi" }), /slack client unavailable/);
});

test("characterization: Retry-After 31s is capped at 30s", async () => {
  let calls = 0;
  const flaky = {
    chat: {
      postMessage: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("ratelimited");
          err.retryAfter = 31;
          throw err;
        }
        return { ts: "capped" };
      },
    },
  };
  const { out, delays } = await withCapturedSleeps(() => sendProgramMessage({ client: flaky, channel: "C1", text: "hi" }));
  assert.equal(out.ts, "capped");
  assert.equal(calls, 2);
  assert.equal(delays[0], 30 * 1000);
});

test("characterization: unknown transient backs off then gives up", async () => {
  // WHY: a bad value must fall to backoff, not a Retry-After wait.
  let calls = 0;
  const broken = {
    chat: {
      postMessage: async () => {
        calls += 1;
        const err = new Error("boom");
        err.retryAfter = "not-a-number";
        throw err;
      },
    },
  };
  const orig = global.setTimeout;
  const delays = [];
  global.setTimeout = (cb, ms) => {
    delays.push(ms);
    cb();
    return 0;
  };
  try {
    await assert.rejects(() => sendProgramMessage({ client: broken, channel: "C1", text: "hi" }), /boom/);
  } finally {
    global.setTimeout = orig;
  }
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test("characterization: branded ratelimit retry preserves brand", async () => {
  // WHY: pinned bug now fixed, so the pin asserts preservation.
  const sent = [];
  let calls = 0;
  const flaky = {
    chat: {
      postMessage: async (payload) => {
        sent.push(payload);
        calls += 1;
        if (calls === 1) {
          const err = new Error("ratelimited");
          err.retryAfter = 0;
          throw err;
        }
        return { ts: "retry-ok" };
      },
    },
  };
  const res = await sendProgramMessage({
    client: flaky,
    program: { name: "Highway", supportName: "Highway Help", iconUrl: "https://example.com/i.png" },
    channel: "C1",
    text: "hi",
  });
  assert.equal(res.ts, "retry-ok");
  assert.ok(sent[0].username);
  assert.equal(sent[1].username, "Highway Help");
});

test("characterization: ticket action failures stay silent, only public_resolve explains", async () => {
  // WHY: buttons must not chatter on failure; the one explain path is pinned here.
  const tickets = require("./tickets");
  const probe = { chat: { postMessage: async () => { throw new Error("must not send on auth failure"); } } };
  for (const fn of [tickets.claimTicket, tickets.resolveTicket, tickets.closeTicket]) {
    const res = await fn({ ticketId: 9999999, actorId: "U-x", client: probe });
    assert.ok(res && res.error);
  }
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/tickets.js", "utf8");
  const hits = (src.match(/postEphemeral/g) || []).length;
  // Only the two public thread buttons explain a not-authorized click; every
  // organizer-card action stays silent on failure.
  assert.equal(hits, 2);
  assert.ok(src.includes("public_resolve_ticket"));
  assert.ok(src.includes("SUPPORT_REOPEN_ACTION"));
});

test("regression: missing or empty Retry-After falls to transient backoff", async () => {
  // WHY: missing must not become a 0ms storm.
  const makers = [
    () => {
      const e = new Error("t");
      return e;
    },
    () => {
      const e = new Error("t");
      e.retryAfter = "";
      return e;
    },
    () => {
      const e = new Error("t");
      e.retryAfter = null;
      return e;
    },
  ];
  for (const make of makers) {
    let calls = 0;
    const broken = { chat: { postMessage: async () => { calls += 1; throw make(); } } };
    const { delays } = await withCapturedSleeps(() => sendProgramMessage({ client: broken, channel: "C1", text: "hi" }).catch(() => null));
    assert.equal(calls, 3);
    assert.deepEqual(delays, [500, 1000]);
  }
});

test("regression: Retry-After header lookup ignores case", async () => {
  // WHY: Slack capitalizes the header, so any case must be honored.
  const keys = ["retry-after", "Retry-After", "RETRY-AFTER"];
  for (const key of keys) {
    let calls = 0;
    const flaky = {
      chat: {
        postMessage: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error("ratelimited");
            err.headers = { [key]: "1" };
            throw err;
          }
          return { ts: "ok" };
        },
      },
    };
    const { out, delays } = await withCapturedSleeps(() => sendProgramMessage({ client: flaky, channel: "C1", text: "hi" }));
    assert.equal(out.ts, "ok");
    assert.equal(delays[0], 1000);
  }
});

test("regression: brand survives ratelimit and drops only on branding rejection", async () => {
  // WHY: ratelimit must not strip identity; only a rejected brand may.
  const sent = [];
  let calls = 0;
  const prog = { name: "Highway", supportName: "Highway Help", iconUrl: "https://example.com/i.png" };
  const client = {
    chat: {
      postMessage: async (payload) => {
        sent.push(payload);
        calls += 1;
        if (calls === 1) {
          const err = new Error("ratelimited");
          err.retryAfter = 0;
          throw err;
        }
        if (calls === 2) {
          const err = new Error("missing_scope");
          err.code = "missing_scope";
          throw err;
        }
        return { ts: "ok" };
      },
    },
  };
  const res = await sendProgramMessage({ client, program: prog, channel: "C1", text: "hi" });
  assert.equal(res.ts, "ok");
  assert.equal(sent.length, 3);
  assert.equal(sent[0].username, "Highway Help");
  assert.equal(sent[1].username, "Highway Help");
  assert.equal(sent[2].username, undefined);
});

test("regression: retry path holds one permanent check with no dead throw", () => {
  // WHY: a second check hides the real exit, so the shape is pinned.
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/slackMessages.js", "utf8");
  assert.equal(src.includes("lastError"), false);
  assert.equal((src.match(/isPermanentError/g) || []).length, 2);
});

test("regression: brandingFor trims, drops empty, and gates iconUrl", () => {
  // WHY: dirty program rows must not leak whitespace or bad icons to Slack.
  const names = [
    [{ supportName: "  A Help  " }, "A Help"],
    [{ supportName: "   ", name: "H" }, undefined],
    [{ supportName: "x".repeat(200) }, "x".repeat(80)],
  ];
  for (const [prog, want] of names) assert.equal(brandingFor(prog).username, want);
  const icons = [
    [{ name: "H", iconUrl: "https://x/y.png" }, "https://x/y.png"],
    [{ name: "H", iconUrl: "http://x/y.png" }, "http://x/y.png"],
    [{ name: "H", iconUrl: "ftp://x/y.png" }, undefined],
    [{ name: "H", iconUrl: "" }, undefined],
  ];
  for (const [prog, want] of icons) assert.equal(brandingFor(prog).icon_url, want);
});

test("regression: duplicate card text carries no stray bracket", () => {
  // WHY: the card line must match its siblings exactly.
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/tickets.js", "utf8");
  assert.ok(src.includes("Duplicate of #${canon}`"));
  assert.equal(src.includes("Duplicate of #${canon}]`"), false);
});
