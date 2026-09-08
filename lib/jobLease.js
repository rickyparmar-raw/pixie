// Single-flight leases for periodic jobs. Concurrent replicas must never run
// the same destructive sweep twice: the winner holds the lease row until it
// expires, losers skip. Takeover happens only after expiry, so a crashed
// holder cannot wedge the job forever.
const db = require("./db");
const log = require("./log");
const crypto = require("crypto");

// Ten minutes: longer than any sweep takes, shorter than any outage that
// matters. Callers pass their own interval as TTL (see radar/sla loops), so
// this is only the default for ad-hoc uses.
const DEFAULT_TTL_MS = 10 * 60 * 1000;

const INSERT_LEASE_SQL = "INSERT OR IGNORE INTO job_leases (name, owner, expires_at) VALUES (?, ?, ?)";
const TAKEOVER_SQL = "UPDATE job_leases SET owner = ?, expires_at = ? WHERE name = ? AND expires_at < ?";
const RELEASE_SQL = "DELETE FROM job_leases WHERE name = ? AND owner = ?";

function ownerId() {
  return `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function tryInsert(name, owner, expiresAt) {
  return db.handle().query(INSERT_LEASE_SQL).run(name, owner, expiresAt).changes > 0;
}

function tryTakeover(name, owner, expiresAt, now) {
  return db.handle().query(TAKEOVER_SQL).run(owner, expiresAt, name, now).changes > 0;
}

function acquire(name, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const owner = ownerId();
  try {
    // Fast path: nobody holds it.
    if (tryInsert(name, owner, now + ttlMs)) return { held: true, owner };
    // Slow path: take over only an expired lease, atomically.
    if (tryTakeover(name, owner, now + ttlMs, now)) return { held: true, owner };
    return { held: false };
  } catch (e) {
    log.debug("jobLease", `acquire ${name} failed: ${e.message}`);
    return { held: false };
  }
}

function release(name, owner) {
  try {
    db.handle().query(RELEASE_SQL).run(name, owner);
  } catch (_) {}
}

// Release-finally: the TTL only matters when the holder crashes mid-run.
// Back-to-back ticks each run exactly once; overlapping ticks (a run
// outlasting its interval while another replica fires) can double-run —
// callers with long jobs should pass a TTL comfortably above their runtime,
// not exactly their interval. Reported, not changed: radar/sla pass
// interval-as-TTL today and their sweeps are idempotent.
async function runOnce(name, ttlMs, fn) {
  const lease = acquire(name, ttlMs);
  if (!lease.held) {
    log.debug("jobLease", `${name} already held — skipping`);
    return { ran: false };
  }
  try {
    return { ran: true, result: await fn() };
  } finally {
    release(name, lease.owner);
  }
}

module.exports = { acquire, release, runOnce, DEFAULT_TTL_MS };
