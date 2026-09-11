// SQLite-backed request reservations. The reservation is deliberately one SQL
// write: a read followed by an insert lets two Slack retries spend the same
// remaining slot.
const db = require("./db");

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.PIXIE_RATE_LIMIT_MAX) || 8;

function decision(allowed, retryInMs, reason) {
  return { allowed, retryInMs, reason };
}

// Accept the old string form as well as the richer event identity. Thread
// identifiers are intentionally not part of the key: a person opening a new
// thread must not get a fresh allowance.
function resolveIdentity(identity, { scope = null } = {}) {
  if (identity && typeof identity === "object") {
    const userId = identity.userId || identity.user_id || identity.id || null;
    const identityScope = identity.scope || identity.channelId || identity.channel_id || scope;
    return { userId, scope: identityScope || "global" };
  }
  return { userId: identity || null, scope: scope || "global" };
}

function reservationKey(identity, resolved, scope) {
  const hasScope = Boolean(scope || (identity && typeof identity === "object" && (
    identity.scope || identity.channelId || identity.channel_id
  )));
  return hasScope ? `${resolved.scope}:${resolved.userId}` : resolved.userId;
}

function check(identity, {
  windowMs = WINDOW_MS,
  max = MAX_PER_WINDOW,
  scope = null,
  dm = false,
  isDm = false,
  requireIdentity = false,
} = {}) {
  const resolved = resolveIdentity(identity, { scope });
  const dmIdentityRequired = dm || isDm || requireIdentity;

  if (!resolved.userId) {
    // Legacy non-DM callers historically treated an absent identity as an
    // unscoped request. DM callers cannot safely do that: one missing Slack
    // field would otherwise share a budget with every other anonymous DM.
    return dmIdentityRequired
      ? decision(false, 0, "missing_identity")
      : decision(true, 0, "no_identity");
  }

  // Keep the historical bare user key when no scope was supplied, so existing
  // reservations continue to count after this implementation is deployed.
  const key = reservationKey(identity, resolved, scope);
  // A scoped reservation must also see the old bare-user rows. Those rows were
  // written before surface-scoped identities existed and remain valid budget
  // reservations; ignoring them would give a user a fresh allowance on the
  // first scoped request after deployment.
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

module.exports = { check, WINDOW_MS, MAX_PER_WINDOW };
