// Database lease
import db = require("./db");
import log = require("./log");
import crypto = require("node:crypto");

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const INSERT_LEASE_SQL = "INSERT OR IGNORE INTO job_leases (name, owner, expires_at) VALUES (?, ?, ?)";
const TAKEOVER_SQL = "UPDATE job_leases SET owner = ?, expires_at = ? WHERE name = ? AND expires_at < ?";
const RELEASE_SQL = "DELETE FROM job_leases WHERE name = ? AND owner = ?";

type Lease = { held: true; owner: string } | { held: false };

function ownerId() {
  return `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function tryInsert(name: string, owner: string, expiresAt: number) {
  return db.handle().query(INSERT_LEASE_SQL).run(name, owner, expiresAt).changes > 0;
}

function tryTakeover(name: string, owner: string, expiresAt: number, now: number) {
  return db.handle().query(TAKEOVER_SQL).run(owner, expiresAt, name, now).changes > 0;
}

function acquire(name: string, ttlMs = DEFAULT_TTL_MS): Lease {
  const now = Date.now();
  const owner = ownerId();
  try {
    if (tryInsert(name, owner, now + ttlMs)) return { held: true, owner };
    if (tryTakeover(name, owner, now + ttlMs, now)) return { held: true, owner };
    return { held: false };
  } catch (e: unknown) {
    log.debug("jobLease", `acquire ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { held: false };
  }
}

function release(name: string, owner: string) {
  try {
    db.handle().query(RELEASE_SQL).run(name, owner);
  } catch (_: unknown) {}
}

async function runOnce<T>(
  name: string,
  ttlMs: number,
  fn: () => T | Promise<T>,
): Promise<{ ran: boolean; result?: T }> {
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

export = { acquire, release, runOnce, DEFAULT_TTL_MS };
