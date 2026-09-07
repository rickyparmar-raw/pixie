// Central program-branded Slack messaging for the shared hosted app.
//
// One @Pixie installation serves many programs, so every outbound support
// message goes through here: it applies the program's support identity
// (display name + icon) via chat:write.customize and falls back to the plain
// Pixie identity when customization is unavailable. Program branding only —
// helper human identity is never impersonated.
//
// Rate-limit behavior is bounded: 429s honor Retry-After up to a cap, then
// give up with a typed error instead of retry-storming the workspace.
const log = require("./log");

const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30 * 1000;

function brandingFor(program) {
  if (!program) return {};
  const out = {};
  const displayName = program.supportName || (program.name ? `${program.name} Help` : null);
  if (displayName) out.username = String(displayName).slice(0, 80);
  if (program.iconUrl) out.icon_url = program.iconUrl;
  return out;
}

function retryAfterMs(err) {
  const header = err && err.retryAfter !== undefined ? err.retryAfter
    : err && err.data && err.data.retryAfter ? err.data.retryAfter
    : err && err.headers && err.headers["retry-after"] ? err.headers["retry-after"]
    : null;
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}

function isPermanentError(err) {
  const code = err && (err.code || (err.data && err.data.error));
  return code === "channel_not_found" || code === "not_in_channel" || code === "is_archived"
    || code === "msg_too_long" || code === "invalid_blocks" || code === "account_inactive";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendProgramMessage({ client, program = null, channel, threadTs = null, text, blocks = null }) {
  if (!client || !client.chat || typeof client.chat.postMessage !== "function") {
    throw new Error("slack client unavailable");
  }
  if (!channel) throw new Error("channel required");
  if (!text && !blocks) throw new Error("text or blocks required");

  const brand = brandingFor(program);
  const base = { channel, ...(threadTs ? { thread_ts: threadTs } : {}), ...(text ? { text } : {}), ...(blocks ? { blocks } : {}) };

  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const payload = attempt === 0 && Object.keys(brand).length > 0 ? { ...base, ...brand } : base;
    try {
      return await client.chat.postMessage(payload);
    } catch (err) {
      lastError = err;
      // Custom identity rejected (missing scope, bad icon): retry once as
      // plain Pixie rather than failing the support reply.
      const code = err && (err.code || (err.data && err.data.error));
      if (attempt === 0 && Object.keys(brand).length > 0 && (code === "invalid_arguments" || code === "not_allowed" || code === "missing_scope")) {
        log.warn("slackMessages", `program branding rejected (${code}) — retrying as Pixie`);
        continue;
      }
      if (isPermanentError(err)) throw err;
      const wait = retryAfterMs(err);
      if (wait !== null && attempt < MAX_ATTEMPTS - 1) {
        await sleep(wait);
        continue;
      }
      // Unknown transient error: one short backoff, then stop.
      if (attempt < MAX_ATTEMPTS - 1 && !isPermanentError(err)) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

module.exports = { sendProgramMessage, brandingFor, MAX_ATTEMPTS };
