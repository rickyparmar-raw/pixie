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
import log = require("./log");
import type { Program, SlackClient } from "./types";
import type { ChatPostMessageArguments } from "@slack/web-api";

interface SlackError {
  code?: unknown;
  data?: { error?: unknown; retryAfter?: unknown };
  retryAfter?: unknown;
  headers?: Record<string, unknown>;
}
interface MessagePayload {
  channel: string;
  thread_ts?: string;
  text?: string;
  blocks?: unknown[];
  username?: string;
  icon_url?: string;
}
interface SendResult {
  ok?: boolean;
  shadowed?: boolean;
  ts?: string | null;
  [key: string]: unknown;
}
type MessageClient = Pick<SlackClient, "chat">;

const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30 * 1000;

// A program-branded Slack send that has exhausted its retries. Recorded so a
// spike of dropped support replies is visible in metrics rather than only in
// the callers that swallow the throw.
function recordSendFailure(program: Program | null | undefined, err: SlackError): void {
  try {
    const code = (err && (err.code || (err.data && err.data.error))) || "unknown";
    require("./db").recordMetric("slack_send_failure", null, String(code).slice(0, 40), program && program.id ? program.id : null);
  } catch (_) {}
}

function brandingFor(program: Program | null | undefined): Record<string, string> {
  if (!program) return {};
  const out: Record<string, string> = {};
  const raw = program.supportName || (program.name ? `${program.name} Help` : null);
  if (raw) {
    const name = String(raw).trim().slice(0, 80);
    if (name) out.username = name;
  }
  // WHY: Slack rejects non-http icons, so only http(s) survives branding.
  if (typeof program.iconUrl === "string" && /^https?:\/\//.test(program.iconUrl)) out.icon_url = program.iconUrl;
  return out;
}

function headerCaseInsensitive(headers: Record<string, unknown>, name: string): unknown {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return headers[key];
  }
  return undefined;
}

function retryAfterMs(err: SlackError | null | undefined): number | null {
  if (!err) return null;
  let header;
  if (err.retryAfter !== undefined) header = err.retryAfter;
  else if (err.data && err.data.retryAfter !== undefined) header = err.data.retryAfter;
  else if (err.headers) header = headerCaseInsensitive(err.headers, "retry-after");
  else header = null;
  // WHY: missing/empty must fall to backoff, not a 0ms retry storm.
  if (header === null || header === undefined || header === "") return null;
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}

function isPermanentError(err: SlackError | null | undefined): boolean {
  const code = err && (err.code || (err.data && err.data.error));
  return code === "channel_not_found" || code === "not_in_channel" || code === "is_archived"
    || code === "msg_too_long" || code === "invalid_blocks" || code === "account_inactive";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendProgramMessage({ client, program = null, channel, threadTs = null, text, blocks = null }: { client: MessageClient; program?: Program | null; channel: string; threadTs?: string | null; text?: string; blocks?: unknown[] | null }): Promise<SendResult> {
  if (!client || !client.chat || typeof client.chat.postMessage !== "function") {
    throw new Error("slack client unavailable");
  }
  if (!channel) throw new Error("channel required");
  if (!text && !blocks) throw new Error("text or blocks required");

  // Shadow mode (migration): evaluate everything, send nothing. The legacy
  // bot still owns the channel, so any public write here would double-reply.
  if (program && program.shadowMode === true) {
    log.debug("slackMessages", `shadowed send suppressed for program ${program.id}`);
    return { ok: false, shadowed: true, ts: null };
  }

  const brand = brandingFor(program);
  const base = { channel, ...(threadTs ? { thread_ts: threadTs } : {}), ...(text ? { text } : {}), ...(blocks ? { blocks } : {}) };

  let useBrand = Object.keys(brand).length > 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const payload = useBrand ? { ...base, ...brand } : base;
    try {
      return await client.chat.postMessage(payload as ChatPostMessageArguments) as SendResult;
    } catch (err) {
      const error = (err && typeof err === "object" ? err : {}) as SlackError;
      // Custom identity rejected (missing scope, bad icon): retry once as
      // plain Pixie rather than failing the support reply.
      const code = error.code || (error.data && error.data.error);
      if (useBrand && (code === "invalid_arguments" || code === "not_allowed" || code === "missing_scope")) {
        if (attempt >= MAX_ATTEMPTS - 1) { recordSendFailure(program, error); throw err; }
        log.warn("slackMessages", `program branding rejected (${code}) — retrying as Pixie`);
        useBrand = false;
        continue;
      }
      if (isPermanentError(error)) { recordSendFailure(program, error); throw err; }
      const wait = retryAfterMs(error);
      if (wait !== null && attempt < MAX_ATTEMPTS - 1) {
        await sleep(wait);
        continue;
      }
      // Unknown transient error: one short backoff, then stop.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      recordSendFailure(program, error);
      throw err;
    }
  }
  throw new Error("slack message attempts exhausted");
}

export = { sendProgramMessage, brandingFor, MAX_ATTEMPTS };
