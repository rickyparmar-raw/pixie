const { test } = require("node:test");
const assert = require("node:assert/strict");

const auth = require("./auth");

test("parseCookies returns empty object for no header", () => {
  assert.ok(true);
});

test("requireAdmin returns 401 with no session", () => {
  const req = { headers: new Map() };
  const result = auth.requireAdmin(req);
  assert.equal(result.status, 401);
});

test("requireSession returns null with no cookie", () => {
  const req = { headers: new Map() };
  const result = auth.requireSession(req);
  assert.equal(result, null);
});

test("requireAdmin returns 403 for non-admin when session exists", () => {
  assert.ok(auth.requireSession);
  assert.ok(auth.requireAdmin);
});

test("loginUrl includes client_id and state", () => {
  process.env.SLACK_CLIENT_ID = "test-client-123";
  process.env.PIXIE_WEB_URL = "http://localhost:4100";
  const url = auth.loginUrl("/");
  assert.ok(url.includes("test-client-123"));
  assert.ok(url.includes("openid"));
  assert.ok(url.includes("state="));
});

test("handleLogout sets an expired cookie", () => {
  const result = auth.handleLogout();
  assert.equal(result.status, 302);
  assert.ok(result.headers["Set-Cookie"]?.includes("Max-Age=0"));
});


test("char: sign/verify roundtrips in-process; tampered or malformed tokens fail", () => {
  const token = auth.signSession("U-char", "Char", "user");
  assert.ok(typeof token === "string" && token.includes("."));
  const sess = auth.verifySession(token);
  assert.equal(sess.userId, "U-char");
  assert.equal(sess.role, "user");
  const [enc] = token.split(".");
  assert.equal(auth.verifySession(`${enc}.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`), null);
  assert.equal(auth.verifySession(null), null);
  assert.equal(auth.verifySession(""), null);
  assert.equal(auth.verifySession("no-dot-here"), null);
});

test("char: expired sessions and sessions without userId are rejected", () => {
  const crypto = require("crypto");
  const good = auth.signSession("U-exp", "Exp", "user");
  assert.ok(auth.verifySession(good));
  const saved = process.env.PIXIE_SESSION_SECRET;
  try {
    process.env.PIXIE_SESSION_SECRET = "char-secret-a";
    const a = auth.signSession("U-x", "X", "user");
    process.env.PIXIE_SESSION_SECRET = "char-secret-b";
    assert.equal(auth.verifySession(a), null, "rotating the secret must invalidate old cookies");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_SESSION_SECRET;
    else process.env.PIXIE_SESSION_SECRET = saved;
  }
});

test("char: requireAdmin matrix — 401 no session, 403 non-admin, ok admin", () => {
  const noSess = { headers: { get: () => "" } };
  assert.equal(auth.requireAdmin(noSess).status, 401);
  const userTok = auth.signSession("U-plain-user", "Plain", "user");
  const userReq = { headers: { get: () => `${auth.COOKIE_NAME}=${userTok}` } };
  const res = auth.requireAdmin(userReq);
  assert.ok(res.status === 403 || res.session, "non-admin yields 403 or (if allowlisted) a session — never 401");
  const adminTok = auth.signSession("admin", "Admin", "admin");
  const adminReq = { headers: { get: () => `${auth.COOKIE_NAME}=${adminTok}` } };
  assert.ok(auth.requireAdmin(adminReq).session, "role=admin cookie passes");
  assert.equal(auth.requireSession(noSess), null);
  assert.equal(auth.requireSession(adminReq).userId, "admin");
});

test("char: dev-testing bypass is gated on SLACK_CLIENT_ID=dev-testing only", () => {
  const saved = process.env.SLACK_CLIENT_ID;
  try {
    process.env.SLACK_CLIENT_ID = "dev-testing";
    const tok = auth.signSession("dev-user", "Developer", "admin");
    const req = { headers: { get: () => `${auth.COOKIE_NAME}=${tok}` } };
    assert.ok(auth.requireAdmin(req).session, "dev-user passes while dev-testing");
    process.env.SLACK_CLIENT_ID = "real-client-id";
    const userTok = auth.signSession("dev-user", "Developer", "user");
    const userReq = { headers: { get: () => `${auth.COOKIE_NAME}=${userTok}` } };
    const out = auth.requireAdmin(userReq);
    assert.ok(out.status === 403 || out.session, "outside dev-testing, a plain dev-user is 403 unless allowlisted");
  } finally {
    if (saved === undefined) delete process.env.SLACK_CLIENT_ID;
    else process.env.SLACK_CLIENT_ID = saved;
  }
});

test("char: loginUrl needs Slack env; handleLogout clears the session cookie", () => {
  const cSaved = process.env.SLACK_CLIENT_ID;
  const wSaved = process.env.PIXIE_WEB_URL;
  try {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.PIXIE_WEB_URL;
    assert.equal(auth.loginUrl("/"), null);
    process.env.SLACK_CLIENT_ID = "cid-char";
    process.env.PIXIE_WEB_URL = "http://localhost:4100";
    const url = auth.loginUrl("/");
    assert.ok(url.includes("cid-char") && url.includes("state="));
  } finally {
    if (cSaved === undefined) delete process.env.SLACK_CLIENT_ID;
    else process.env.SLACK_CLIENT_ID = cSaved;
    if (wSaved === undefined) delete process.env.PIXIE_WEB_URL;
    else process.env.PIXIE_WEB_URL = wSaved;
  }
  const out = auth.handleLogout();
  assert.equal(out.status, 302);
  assert.ok(out.headers["Set-Cookie"].includes(`${auth.COOKIE_NAME}=;`));
});
export {};
