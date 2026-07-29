// Shared OpenAI-compatible chat-completions client. answer/intent/chat/vision
// all POST the same shape to different base URLs with different keys, so the
// transport — including retry policy — lives here once.
const axios = require("axios");
const https = require("https");
const log = require("./log");

// 25s was long enough that three attempts could stack to 75s+ before the user
// saw anything. Measured p90 for a real answer is ~4s, so 12s is still four
// standard deviations of slack while bounding the worst case to ~36s.
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

// axios opens a fresh TLS connection per request by default, so every call paid
// a full handshake. Reusing sockets is worth ~200ms per call and, more usefully,
// collapses the spread — measured interleaved against the live endpoint, the
// range tightened from 1632-2744ms to 1711-2055ms.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

// Transient: worth another attempt. Anything else (401, 400, 404) is a config
// or prompt problem that retrying can only make slower.
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function isRetryableError(err) {
  if (err.response) return isRetryableStatus(err.response.status);
  // No response at all — timeout, socket hang-up, DNS blip.
  return true;
}

function backoffMs(attempt) {
  // 400ms, 800ms, 1600ms + jitter, so a burst of concurrent questions doesn't
  // retry in lockstep against an endpoint that's already rate-limiting us.
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One request. Returns the raw text plus finish_reason so callers can detect
// the empty-completion case (see complete() below).
async function requestCompletion({ baseUrl, apiKey, model, messages, maxTokens, temperature, thinking, timeout }) {
  const res = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      max_tokens: maxTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(thinking === undefined ? {} : { thinking }),
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: timeout || DEFAULT_TIMEOUT_MS,
      httpsAgent: keepAliveAgent,
    },
  );

  return {
    text: res.data?.choices?.[0]?.message?.content,
    finishReason: res.data?.choices?.[0]?.finish_reason,
  };
}

// Retries on two distinct failure modes:
//
//  1. Transient HTTP (429/5xx/timeout) — exponential backoff. Previously these
//     escaped on the first attempt and surfaced to the user as an error string.
//  2. Empty completion with finish_reason "length" — deepseek-v4-flash-free is
//     a reasoning model that sometimes burns its whole token budget on
//     invisible thinking tokens before writing anything visible. Non-
//     deterministic, so a fresh attempt usually succeeds; cheaper than paying
//     for a different model to work around a free tier's inconsistency.
//
// Throws the last error if every attempt fails.
async function complete(options, scope = "llm") {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await requestCompletion(options);
      if (result.text?.trim() || result.finishReason !== "length") return result;
      log.debug(scope, `empty completion (finish_reason=length), attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err)) throw err;
      const status = err.response?.status || "network";
      log.debug(scope, `request failed (${status}), attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    }

    if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt));
  }

  if (lastError) throw lastError;
  // All attempts came back empty — treat as "no answer" rather than an error.
  return { text: "", finishReason: "length" };
}

module.exports = {
  complete,
  requestCompletion,
  isRetryableStatus,
  isRetryableError,
  keepAliveAgent,
  MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
};
