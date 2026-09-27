

type TestAny = any;
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const lease = require("./jobLease");

db.open(":memory:");

function clearLease(name: TestAny) {
  db.handle().query("DELETE FROM job_leases WHERE name = ?").run(name);
}

test("char: first acquire holds, second loses while held", () => {
  clearLease("char-lease-a");
  const a = lease.acquire("char-lease-a", 60000);
  assert.equal(a.held, true);
  assert.ok(a.owner);
  assert.equal(lease.acquire("char-lease-a", 60000).held, false);
  lease.release("char-lease-a", a.owner);
});

test("char: release only releases the holder's own lease", () => {
  clearLease("char-lease-b");
  const a = lease.acquire("char-lease-b", 60000);
  lease.release("char-lease-b", "someone-else");
  assert.equal(lease.acquire("char-lease-b", 60000).held, false);
  lease.release("char-lease-b", a.owner);
  assert.equal(lease.acquire("char-lease-b", 60000).held, true);
  clearLease("char-lease-b");
});

test("char: expired leases are taken over atomically", () => {
  clearLease("char-lease-c");
  lease.acquire("char-lease-c", 60000);
  db.handle().query("UPDATE job_leases SET expires_at = ? WHERE name = ?").run(Date.now() - 1, "char-lease-c");
  const takeover = lease.acquire("char-lease-c", 60000);
  assert.equal(takeover.held, true);
  clearLease("char-lease-c");
});

test("char: runOnce skips when held and reports ran:false", async () => {
  clearLease("char-lease-d");
  const held = lease.acquire("char-lease-d", 60000);
  let called = false;
  const res = await lease.runOnce("char-lease-d", 60000, async () => { called = true; });
  assert.deepEqual(res, { ran: false });
  assert.equal(called, false);
  lease.release("char-lease-d", held.owner);
});

test("char: runOnce runs and releases — the next run may proceed", async () => {
  clearLease("char-lease-e");
  const first = await lease.runOnce("char-lease-e", 60000, async () => 42);
  assert.deepEqual(first, { ran: true, result: 42 });
  const second = await lease.runOnce("char-lease-e", 60000, async () => 7);
  assert.deepEqual(second, { ran: true, result: 7 });
  clearLease("char-lease-e");
});

test("char: runOnce releases even when fn throws (release-finally)", async () => {
  clearLease("char-lease-f");
  await assert.rejects(() => lease.runOnce("char-lease-f", 60000, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(lease.acquire("char-lease-f", 60000).held, true);
  clearLease("char-lease-f");
});

test("char: TTL==interval assessment — release-finally means back-to-back ticks each run once", async () => {
  clearLease("char-lease-g");
  const interval = 50;
  let runs = 0;
  await lease.runOnce("char-lease-g", interval, async () => { runs += 1; });
  await lease.runOnce("char-lease-g", interval, async () => { runs += 1; });
  assert.equal(runs, 2);
  clearLease("char-lease-g");
});
export {};
