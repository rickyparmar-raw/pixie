// Single-flight leases for periodic jobs. Concurrent replicas must never run
// the same destructive sweep twice: the winner holds the lease row until it
// expires, losers skip. Takeover happens only after expiry, so a crashed
// holder cannot wedge the job forever.
const db = require("./db");
const log = require("./log");
const crypto = require("crypto");

function ownerId() {
  return `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function acquire(name, ttlMs = 10 * 60 * 1000) {
  const now = Date.now();
  const owner = ownerId();
  try {
    // Fast path: nobody holds it.
    const res = db.handle().query("INSERT OR IGNORE INTO job_leases (name, owner, expires_at) VALUES (?, ?, ?)")
      .run(name, owner, now + ttlMs);
    if (res.changes > 0) return { held: true, owner };
    // Slow path: take over only an expired lease, atomically.
    const taken = db.handle().query("UPDATE job_leases SET owner = ?, expires_at = ? WHERE name = ? AND expires_at < ?")
      .run(owner, now + ttlMs, name, now);
    return taken.changes > 0 ? { held: true, owner } : { held: false };
  } catch (e) {
    log.debug("jobLease", `acquire ${name} failed: ${e.message}`);
    return { held: false };
  }
}

function release(name, owner) {
  try {
    db.handle().query("DELETE FROM job_leases WHERE name = ? AND owner = ?").run(name, owner);
  } catch (_) {}
}

async function runOnce(name, ttlMs, fn) {
  const lease = acquire(name, ttlMs);
  if (!lease.held) {
    log.debug("jobLease", `${name} already held — skipping`);
    return { ran: false };
  }
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    release(name, lease.owner);
  }
}

module.exports = { acquire, release, runOnce };
