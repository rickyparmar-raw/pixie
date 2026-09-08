process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");

before(() => {
  db.close();
  db.open(":memory:");
});

// handleRequest is the top-level dispatcher: it decides which paths ever
// reach handleApi() (which is where /internal/v1/* routes, and their auth,
// actually live). A dispatcher that only forwards "/api/" would 404 every
// internal API call — program sync, tickets, analytics, membership checks,
// everything the Wizard depends on — before handleApi's own auth even runs,
// regardless of whether PIXIE_INTERNAL_TOKEN is configured correctly.
test("handleRequest dispatches /internal/v1/* to the API handler, not the static 404 fallback", async () => {
  const savedToken = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "test-serve-token";
  try {
    const serve = require("./serve");
    const req = new Request("http://localhost/internal/v1/health", {
      headers: { Authorization: "Bearer test-serve-token" },
    });
    const res = await serve.handleRequest(req);
    assert.equal(res.status, 200, "a correctly authed internal route must not fall through to the generic 404");
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    if (savedToken === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = savedToken;
  }
});

test("handleRequest still gates /internal/v1/* with the wrong token — dispatch isn't the same as bypassing auth", async () => {
  const savedToken = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "test-serve-token";
  try {
    const serve = require("./serve");
    const req = new Request("http://localhost/internal/v1/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const res = await serve.handleRequest(req);
    assert.equal(res.status, 401);
  } finally {
    if (savedToken === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = savedToken;
  }
});

test("an actually unmatched route still falls through to the plain 404", async () => {
  const serve = require("./serve");
  const req = new Request("http://localhost/definitely-not-a-real-route");
  const res = await serve.handleRequest(req);
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.equal(text, "not found");
});

/* ------------------------------------------------------------------ */
/* STEP 1 characterization pins (serve.js dispatch + status mapping).  */
/* Pins CURRENT behavior — the rewrite keeps routes/statuses/shapes    */
/* identical unless a genuine bug ships with evidence + regression.    */
/* ------------------------------------------------------------------ */

function withToken(tok) {
  return { Authorization: `Bearer ${tok}` };
}

test("char: absent PIXIE_INTERNAL_TOKEN → 404 (not 401/403); bad bearer → 401", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  const serve = require("./serve");
  try {
    delete process.env.PIXIE_INTERNAL_TOKEN;
    const disabled = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("anything") }),
    );
    assert.equal(disabled.status, 404);
    const body = await disabled.json();
    assert.match(body.error, /disabled/);

    process.env.PIXIE_INTERNAL_TOKEN = "char-serve-token";
    const bad = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("wrong") }),
    );
    assert.equal(bad.status, 401);
    const noHeader = await serve.handleRequest(new Request("http://localhost/internal/v1/health"));
    assert.equal(noHeader.status, 401);
    const good = await serve.handleRequest(
      new Request("http://localhost/internal/v1/health", { headers: withToken("char-serve-token") }),
    );
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("char: dashboard gates — pulse/stream/ask/health need session; writes need admin", async () => {
  const serve = require("./serve");
  const auth = require("./auth");
  const anon = new Request("http://localhost/api/pulse");
  assert.equal((await serve.handleRequest(anon)).status, 401);
  assert.equal((await serve.handleRequest(new Request("http://localhost/api/health"))).status, 401);
  assert.equal(
    (await serve.handleRequest(new Request("http://localhost/api/queue"))).status,
    401,
    "writes without any session are 401, not 403",
  );
  const userTok = auth.signSession("U-serve-plain", "Plain", "user");
  const userHeaders = { Cookie: `${auth.COOKIE_NAME}=${userTok}` };
  assert.equal((await serve.handleRequest(new Request("http://localhost/api/pulse", { headers: userHeaders }))).status, 200);
  const forbidden = await serve.handleRequest(new Request("http://localhost/api/queue", { headers: userHeaders }));
  assert.ok([403, 200].includes(forbidden.status), "non-admin queue read is 403 unless the deployer allowlisted the user");
  const adminTok = auth.signSession("admin", "Admin", "admin");
  const adminHeaders = { Cookie: `${auth.COOKIE_NAME}=${adminTok}` };
  assert.equal((await serve.handleRequest(new Request("http://localhost/api/queue", { headers: adminHeaders }))).status, 200);
  // An admin browser session alone does NOT open the internal API without the token header.
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-serve-token-2";
  try {
    const sessOnly = await serve.handleRequest(new Request("http://localhost/internal/v1/health", { headers: adminHeaders }));
    assert.equal(sessOnly.status, 401);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("char: internal error→status mapping per route family (pinned current values)", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-map-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("char-map-token");
  try {
    // Unknown internal route → 404.
    assert.equal((await serve.handleRequest(new Request("http://localhost/internal/v1/nope", { headers: H }))).status, 404);
    // Ticket search without tenant → 400.
    assert.equal((await serve.handleRequest(new Request("http://localhost/internal/v1/tickets", { headers: H }))).status, 400);
    // Missing ticket → currently 400 (pinned; see report on 404-vs-400).
    api.internalProgramSync("char-map", { name: "Map", workspaceId: "TW-M", claimedBy: "U-map-org", programChannels: [] });
    const miss = await serve.handleRequest(
      new Request("http://localhost/internal/v1/tickets/999999/claim", {
        method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-map-org" }),
      }),
    );
    assert.equal(miss.status, 400);
    assert.match((await miss.json()).error, /not found/);
    // Program mismatch → 403.
    const tid = require("../db").createTicket({ programId: "char-map", workspaceId: "TW-M", channel: "C1", threadTs: "char-map-1", requesterId: "U1", question: "q" });
    const mm = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/claim`, {
        method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "wrong-prog", actorId: "U-map-org" }),
      }),
    );
    assert.equal(mm.status, 403);
    // Stranger actor → 403.
    const denied = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/claim`, {
        method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-stranger-map" }),
      }),
    );
    assert.equal(denied.status, 403);
    // Unknown action → 400.
    const unk = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/tickets/${tid}/frobnicate`, {
        method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ programId: "char-map", actorId: "U-map-org" }),
      }),
    );
    assert.equal(unk.status, 400);
    // Retention sweep without confirm/organizer → 403 (not 400).
    const sweep = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/char-map/retention", {
        method: "POST", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-stranger-map", confirm: true }),
      }),
    );
    assert.equal(sweep.status, 403);
    // Malformed JSON body never 500s — it degrades to a validation error.
    const malformed = await serve.handleRequest(
      new Request("http://localhost/internal/v1/programs/Bad_Slug!/x", {
        method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: "{not-json",
      }),
    );
    assert.ok([400, 404].includes(malformed.status), "malformed bodies must not become 500s");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("char: internal responses never leak token/secret fields", async () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-leak-token";
  const serve = require("./serve");
  try {
    const H = withToken("char-leak-token");
    // NOTE: /internal/v1/slack/channels is intentionally NOT pinned here —
    // with a real SLACK_BOT_TOKEN present it dials Slack (network) and would
    // flake/time out under test. Health + programs are pure-local.
    for (const path of ["/internal/v1/health", "/internal/v1/programs"]) {
      const res = await serve.handleRequest(new Request(`http://localhost${path}`, { headers: H }));
      const text = await res.text();
      assert.equal(text.includes("char-leak-token"), false, `${path} must not echo the bearer`);
      assert.equal(/"secret"\s*:/i.test(text), false, `${path} must not carry secret fields`);
      assert.equal(/PIXIE_INTERNAL_TOKEN/.test(text), false);
    }
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("regression: DELETE /internal/v1/macros/:id reads its JSON body (actorId survives)", async () => {
  // Evidence: pixie-wizard lib/pixieCore.ts coreMacroDelete sends DELETE with
  // a JSON body { actorId }. Before the fix serve.js only parsed bodies for
  // POST/PUT/PATCH, so every macro DELETE arrived as {} and failed closed
  // with 403 even for a legitimate organizer. The fix adds DELETE to the
  // parsed methods; behavior for all other DELETE routes is unchanged (they
  // ignore the body).
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "char-del-token";
  const serve = require("./serve");
  const api = require("./api");
  const H = withToken("char-del-token");
  try {
    api.internalProgramSync("char-del", { name: "Del", workspaceId: "TW-D", claimedBy: "U-del-org", programChannels: [] });
    const created = api.internalMacroCreate("char-del", { actorId: "U-del-org", trigger: "?delpin", name: "Del", content: "bye {helper}" });
    assert.equal(created.ok, true);
    const mid = created.macro.id;
    // Stranger DELETE still 403 (actor check intact).
    const denied = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/macros/${mid}`, {
        method: "DELETE", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-del-stranger" }),
      }),
    );
    assert.equal(denied.status, 403);
    // Organizer DELETE now reaches the actor check with its body and succeeds.
    const ok = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/macros/${mid}`, {
        method: "DELETE", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: "U-del-org" }),
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});
