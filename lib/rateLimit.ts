// Rate limits are atomic reservations in SQLite, with scoped keys kept distinct
// from legacy user-only rows so a DM cannot borrow another channel's allowance.
import db = require("./db");

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.PIXIE_RATE_LIMIT_MAX) || 8;

interface RateLimitIdentity {
  userId?: string | null;
  user_id?: string | null;
  id?: string | null;
  scope?: string | null;
  channelId?: string | null;
  channel_id?: string | null;
}
interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  scope?: string | null;
  dm?: boolean;
  isDm?: boolean;
  requireIdentity?: boolean;
}

function decision(allowed: boolean, retryInMs: number, reason: string) {
  return { allowed, retryInMs, reason };
}


function resolveIdentity(identity: string | RateLimitIdentity | null, { scope = null }: { scope?: string | null } = {}): { userId: string | null; scope: string } {
  if (identity && typeof identity === "object") {
    const userId: string | null = identity.userId || identity.user_id || identity.id || null;
    const identityScope = identity.scope || identity.channelId || identity.channel_id || scope;
    return { userId, scope: identityScope || "global" };
  }
  return { userId: typeof identity === "string" ? identity : null, scope: scope || "global" };
}

function reservationKey(identity: string | RateLimitIdentity | null, resolved: { userId: string | null; scope: string }, scope: string | null) {
  // Preserve the old user-only key when no scope was supplied for compatibility.
  const hasScope = Boolean(scope || (identity && typeof identity === "object" && (
    identity.scope || identity.channelId || identity.channel_id
  )));
  return hasScope ? `${resolved.scope}:${resolved.userId}` : resolved.userId;
}

function check(identity: string | RateLimitIdentity | null, {
  windowMs = WINDOW_MS,
  max = MAX_PER_WINDOW,
  scope = null,
  dm = false,
  isDm = false,
  requireIdentity = false,
}: RateLimitOptions = {}) {
  const resolved = resolveIdentity(identity, { scope });
  const dmIdentityRequired = dm || isDm || requireIdentity;

  if (!resolved.userId) {
    return dmIdentityRequired
      ? decision(false, 0, "missing_identity")
      : decision(true, 0, "no_identity");
  }

  const key = reservationKey(identity, resolved, scope);
  const legacyKey = resolved.userId;
  const now = Date.now();
  const result = db.handle()
    .query(
      `INSERT INTO rate_limits (user_id, created_at)
       SELECT ?, ?
       WHERE (SELECT COUNT(*) FROM rate_limits
              WHERE user_id IN (?, ?) AND created_at > ?) < ?`,
    )
    .run(key, now, key, legacyKey, now - windowMs, max);

  return result.changes > 0
    ? decision(true, 0, "reserved")
    : decision(false, windowMs, "limit");
}

export = { check, WINDOW_MS, MAX_PER_WINDOW };
