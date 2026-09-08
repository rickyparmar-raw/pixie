const { test } = require("node:test");
const assert = require("node:assert/strict");
const guard = require("./sourceGuard");

test("private IPv4 ranges are not public", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "0.0.0.0", "224.0.0.1"]) {
    assert.equal(guard.isPublicV4(ip), false, ip);
  }
  assert.equal(guard.isPublicV4("8.8.8.8"), true);
  assert.equal(guard.isPublicV4("172.15.0.1"), true);
  assert.equal(guard.isPublicV4("172.32.0.1"), true);
});

test("private IPv6 incl. mapped v4 are not public", () => {
  assert.equal(guard.isPublicV6("::1"), false);
  assert.equal(guard.isPublicV6("fe80::1"), false);
  assert.equal(guard.isPublicV6("fc00::1"), false);
  assert.equal(guard.isPublicV6("::ffff:10.0.0.1"), false);
  assert.equal(guard.isPublicV6("::ffff:8.8.8.8"), true);
});

test("validateUrl blocks protocols, private literals, and junk", async () => {
  await assert.rejects(() => guard.validateUrl("file:///etc/passwd"), /protocol/);
  await assert.rejects(() => guard.validateUrl("gopher://x"), /protocol/);
  await assert.rejects(() => guard.validateUrl("http://localhost:3000/x"), /private host/);
  await assert.rejects(() => guard.validateUrl("http://127.0.0.1/"), /private host/);
  await assert.rejects(() => guard.validateUrl("http://169.254.169.254/latest"), /private host/);
  await assert.rejects(() => guard.validateUrl("http://192.168.0.5/"), /private host/);
  await assert.rejects(() => guard.validateUrl("http://foo.local/"), /private host/);
  await assert.rejects(() => guard.validateUrl("not a url"), /unparseable/);
});

test("ingestion rejects blocked URLs before any fetch", async () => {
  const knowledge = require("./knowledge");
  await assert.rejects(
    () => knowledge.fetchSourceText({ name: "evil", type: "url", url: "http://169.254.169.254/" }),
    /blocked source URL/,
  );
});

/* ------------------------------------------- STEP 1 characterization pins -- */

test("redirect budget pins at five hops", () => {
  assert.equal(guard.MAX_REDIRECTS, 5);
});

test("private-looking hostnames never validate", () => {
  assert.equal(guard.hostnameLooksPrivate("localhost"), true);
  assert.equal(guard.hostnameLooksPrivate("foo.local"), true);
  assert.equal(guard.hostnameLooksPrivate("foo.internal"), true);
  assert.equal(guard.hostnameLooksPrivate("foo.lan"), true);
  assert.equal(guard.hostnameLooksPrivate("example.com"), false);
});

test("file and non-http protocols never validate", async () => {
  await assert.rejects(() => guard.validateUrl("ftp://example.com/x"), /protocol/);
  await assert.rejects(() => guard.validateUrl("file://./quick-links.json"), /protocol/);
});
