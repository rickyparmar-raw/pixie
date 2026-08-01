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
async function completeAttempts(options, scope) {
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

/* -------------------------------------------------------------- fallback -- */

// Pointing a call site at a self-hosted gateway (9Router, a local proxy) buys a
// better model than the free tier, at the cost of depending on a component that
// can simply be down. `options.fallback` names a standby to try once the primary
// has exhausted its retries.
//
// This exists because of the failure mode it prevents, which is worse than it
// looks: an unreachable gateway threw, classifyIntent turned the throw into a
// null verdict, and HELP_ONLY reads null as "nobody was asking" — so a dead
// router made pixie mute in every gated channel with nothing in the logs
// pointing at the cause. Degraded answers beat silence.
function describeError(err) {
  return err.response?.status || err.cause?.code || err.code || "network";
}

async function complete(options, scope = "llm") {
  const { fallback, ...primary } = options;

  try {
    return await completeAttempts(primary, scope);
  } catch (err) {
    if (!fallback) throw err;
    log.warn(scope, `${primary.baseUrl} failed (${describeError(err)}) — falling back to ${fallback.baseUrl}`);
    return await completeAttempts({ ...primary, ...fallback }, `${scope}-fallback`);
  }
}

/* ------------------------------------------------------------- streaming -- */

// Non-streaming answers meant nothing was on screen until the whole completion
// landed — measured p50 4891ms with the first token available at ~1500ms. The
// gap was pure dead air.
//
// Built on global fetch rather than axios: Bun's fetch gives a real
// ReadableStream and pools connections itself, and this is the exact shape
// measured against Zen. complete() keeps axios — short classifier-style calls
// gain nothing from streaming and want the retry semantics above.

// SSE frames arrive split across chunk boundaries, so a partial line is held
// back until its newline shows up. Returns the deltas found in `buffer` and
// whatever tail could not be parsed yet.
function parseSseChunk(buffer) {
  const deltas = [];
  const lines = buffer.split("\n");
  const rest = lines.pop();

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      // A frame we can't read is one lost token, not a failed answer.
      continue;
    }
    const delta = frame?.choices?.[0]?.delta?.content;
    if (delta) deltas.push(delta);
  }

  return { deltas, rest };
}

// One streaming attempt. `onDelta` is called with each fragment as it arrives;
// returning false from it stops the stream (used by the SILENT gate, which
// knows the answer is nothing after the very first token).
async function streamCompletion({ baseUrl, apiKey, model, messages, maxTokens, temperature, thinking, timeout }, onDelta) {
  const controller = new AbortController();
  // Armed against time-to-FIRST-token, not total duration: a stream that is
  // still producing text is healthy however long it runs, and killing it
  // mid-sentence would truncate a reply already visible in Slack.
  let timer = setTimeout(() => controller.abort(), timeout || DEFAULT_TIMEOUT_MS);
  const clearFirstTokenTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(temperature === undefined ? {} : { temperature }),
        ...(thinking === undefined ? {} : { thinking }),
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`stream failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      err.response = { status: res.status };
      throw err;
    }
    if (!res.body) throw new Error("stream failed: no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let stopped = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { deltas, rest } = parseSseChunk(buffer);
      buffer = rest;

      for (const delta of deltas) {
        clearFirstTokenTimer();
        text += delta;
        if (onDelta && onDelta(delta, text) === false) {
          stopped = true;
          break;
        }
      }

      if (stopped) {
        controller.abort();
        break;
      }
    }

    return { text, stopped };
  } finally {
    clearFirstTokenTimer();
  }
}

// Retries only when NOTHING was streamed. Once a fragment has been handed to
// onDelta it is already on screen, and a second attempt would rewrite the reply
// in front of whoever is reading it.
async function streamAttempts(options, onDelta, scope) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let streamed = false;
    const track = (delta, text) => {
      streamed = true;
      return onDelta ? onDelta(delta, text) : undefined;
    };

    try {
      const result = await streamCompletion(options, track);
      if (result.text.trim() || result.stopped) return result;
      log.debug(scope, `empty stream, attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    } catch (err) {
      lastError = err;
      if (streamed) throw err;
      if (!isRetryableError(err)) throw err;
      const status = err.response?.status || "network";
      log.debug(scope, `stream failed (${status}), attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    }

    if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt));
  }

  if (lastError) throw lastError;
  return { text: "", stopped: false };
}

async function completeStream(options, onDelta, scope = "llm") {
  const { fallback, ...primary } = options;

  // Tracked across attempts, not within one: the moment any text reaches Slack
  // the reply is visible, and a standby model would rewrite it mid-sentence in
  // front of whoever is reading. Falling back is only safe from silence.
  let streamedAny = false;
  const track = (delta, text) => {
    streamedAny = true;
    return onDelta ? onDelta(delta, text) : undefined;
  };

  try {
    return await streamAttempts(primary, track, scope);
  } catch (err) {
    if (!fallback || streamedAny) throw err;
    log.warn(scope, `${primary.baseUrl} failed (${describeError(err)}) — falling back to ${fallback.baseUrl}`);
    return await streamAttempts({ ...primary, ...fallback }, track, `${scope}-fallback`);
  }
}

module.exports = {
  complete,
  completeStream,
  requestCompletion,
  streamCompletion,
  parseSseChunk,
  isRetryableStatus,
  isRetryableError,
  keepAliveAgent,
  MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
};
