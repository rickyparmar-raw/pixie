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
