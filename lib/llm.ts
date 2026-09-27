// Shared OpenAI-compatible chat-completions client. answer/intent/chat/vision
// all POST the same shape to different base URLs with different keys, so the
// transport — including retry policy — lives here once.
const axios = require("axios");
const https = require("https");
const log = require("./log");
const db = require("./db");
const crypto = require("crypto");

// 25s was long enough that three attempts could stack to 75s+ before the user
// saw anything. Measured p90 for a real answer is ~4s, so 12s is still four
// standard deviations of slack while bounding the worst case to ~36s.
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

// axios opens a fresh TLS connection per request by default, so every call paid
// a full handshake. Reusing sockets is worth ~200ms per call and, more usefully,
// collapses the spread — measured interleaved against the live endpoint, the
// range tightened from 1632-2744ms to 1711-2055ms.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

// Transient: worth another attempt. Anything else (401, 400, 404) is a config
// or prompt problem that retrying can only make slower.
function isRetryableStatus(status: any) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function isRetryableError(err: any) {
  if (err.response) return isRetryableStatus(err.response.status);
  // No response at all — timeout, socket hang-up, DNS blip.
  return true;
}

function usageFor(data: any) {
  const usage = data?.usage || {};
  return {
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    cachedPromptTokens: usage.cached_prompt_tokens ?? usage.cache_read_input_tokens ?? null,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

const KNOWN_PRICING = Object.freeze({
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
});

function costFor(model: any, usage: any) {
  let prices: Record<string, any> = { ...KNOWN_PRICING };
  try { prices = { ...KNOWN_PRICING, ...JSON.parse(process.env.PIXIE_LLM_PRICING_JSON || "{}") }; } catch (_: any) { prices = { ...KNOWN_PRICING }; }
  const price = prices[model];
  if (!price || usage.promptTokens === null || usage.completionTokens === null) return null;
  return (usage.promptTokens * Number(price.input || 0) + usage.completionTokens * Number(price.output || 0)) / 1000000;
}

function recordUsage(options: any, result: any = {}) {
  const context = options.telemetry || {};
  const usage = result.usage || {};
  try {
    db.recordLlmUsage({
      operation: context.operation || "llm",
      provider: context.provider || providerFor(options.baseUrl),
      programId: context.programId,
      channel: context.channel,
      requestId: context.requestId,
      eventId: result.eventId || crypto.randomUUID(),
      model: options.model,
      status: result.status || "error",
      httpStatus: result.httpStatus,
      attempt: result.attempt,
      retryCount: result.retryCount,
      ...usage,
      costUsd: costFor(options.model, usage),
      errorKind: result.errorKind,
      rateLimited: result.httpStatus === 429,
      latencyMs: result.latencyMs,
    });
  } catch (e: any) {
    log.debug("llm", `telemetry failed: ${e.message}`);
  }
}

function providerFor(baseUrl: any) {
  try { return new URL(baseUrl).hostname || null; } catch (_: any) { return null; }
}

function backoffMs(attempt: any) {
  // 400ms, 800ms, 1600ms + jitter, so a burst of concurrent questions doesn't
  // retry in lockstep against an endpoint that's already rate-limiting us.
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 200);
}

function sleep(ms: any) {
  return new Promise((resolve: any) => setTimeout(resolve, ms));
}

// WHY: one attribution rule, not one per loop. A 429 penalizes the key that
// actually 429'd (err.usedKey, set by requestCompletion/streamCompletion), not
// whatever the rotation hands back next — penalizing the next key punishes an
// unrelated healthy key and lets the hotspot keep burning.
function noteRateLimit(options: any, err: any) {
  if (err?.response?.status !== 429 || !options.onRateLimited) return;
  const usedKey = err.usedKey || (typeof options.apiKey === "function" ? options.apiKey() : options.apiKey);
  options.onRateLimited(usedKey);
}

// `thinking` is DeepSeek-native. Zen honours it and it is worth ~4x on latency
// there, but other gateways can reject an unknown field outright — so it is only
// sent to models that understand it.
//
// A bare "deepseek" match isn't enough: a gateway's own catalogue can name a
// model "deepseek/..." too (HCAI does), and that model is DeepSeek by way of a
// proxy that doesn't know this param either. Every gateway-catalogue name in
// this codebase is namespaced with a "/" (kr/claude-sonnet-4.5,
// gc/gemini-3.1-flash-lite-preview, deepseek/deepseek-v4-flash-latest) —
// Zen's own native names never are — so excluding anything with a "/" is what
// actually distinguishes "real Zen DeepSeek" from "DeepSeek behind someone
// else's gateway", which a bare substring match on "deepseek" cannot.
function thinkingFor(model: any, thinking: any) {
  return thinking && !/\//.test(model || "") && /deepseek/i.test(model || "") ? thinking : undefined;
}

function stripThinking(text: any) {
  if (!text) return "";
  let clean = text
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/^[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*$/gi, "")
    .trim();

  while (true) {
    const next = clean.replace(
      /^(?:User\s+Safety|Safety\s+Assessment|Safety|Content\s+Filter|Safety\s+Category|Safety\s+Verdict):\s*[^\n]+\s*\n*/i,
      "",
    ).trim();
    if (next === clean) break;
    clean = next;
  }

  if (/^(?:Here(?:\x27s|\x20is) (?:a |the )?thinking process:?|\*\*Thinking Process:?\*\*|Thinking Process:?)/i.test(clean)) {
    const markers = [
      /\n(?:SOURCE|ANSWER):\s*/i,
      /\n[•\*]\s*\*Asker:\*/i,
      /\n(?:[^\n:]+)\s*::\s*(?:[^\n]+)$/m,
    ];
    let foundIndex = -1;
    for (const m of markers) {
      const match = clean.match(m);
      if (match && (foundIndex === -1 || match.index < foundIndex)) {
        foundIndex = match.index;
      }
    }
    if (foundIndex !== -1) {
      clean = clean.slice(foundIndex).trim();
    } else {
      clean = "";
    }
  }

  return clean;
}


// One request. Returns the raw text plus finish_reason so callers can detect
// the empty-completion case (see complete() below).
async function requestCompletion({ baseUrl, apiKey, model, messages, maxTokens, temperature, thinking, timeout }: any) {
  const usedKey = typeof apiKey === "function" ? apiKey() : apiKey;
  const filteredThinking = thinkingFor(model, thinking);

  try {
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        max_tokens: maxTokens,
        ...(temperature === undefined ? {} : { temperature }),
        ...(filteredThinking === undefined ? {} : { thinking: filteredThinking }),
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${usedKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeout || DEFAULT_TIMEOUT_MS,
        httpsAgent: keepAliveAgent,
      },
    );

    const rawContent = res.data?.choices?.[0]?.message?.content;
    const cleanContent = stripThinking(rawContent);

    return {
      text: cleanContent,
      finishReason: res.data?.choices?.[0]?.finish_reason,
      usedKey,
      usage: usageFor(res.data),
    };
  } catch (err: any) {
    // Attribution for the retry loop's onRateLimited: without this, a catch
    // block has no way to know which key just 429'd and ends up penalizing
    // whatever the rotation hands back next — an unrelated, healthy key.
    err.usedKey = usedKey;
    throw err;
  }
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
async function completeAttempts(options: any, scope: any) {
  let lastError: any = null;
  const requestId = options.telemetry?.requestId || crypto.randomUUID();
  const instrumented = { ...options, telemetry: { ...options.telemetry, operation: options.telemetry?.operation || scope, requestId } };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const result: any = await requestCompletion(instrumented);
      result.attempt = attempt + 1;
      result.retryCount = attempt;
      result.latencyMs = Date.now() - startedAt;
      recordUsage(instrumented, { ...result, status: result.text?.trim() ? "success" : "empty" });
      if (result.text?.trim()) return result;
      log.debug(scope, `empty completion (finish_reason=${result.finishReason}), attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    } catch (err: any) {
      lastError = err;
      recordUsage(instrumented, { status: "error", httpStatus: err.response?.status, attempt: attempt + 1, retryCount: attempt, latencyMs: Date.now() - startedAt, errorKind: err.response?.status === 429 ? "rate_limit" : (err.code || "request") });
      noteRateLimit(options, err);
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
function describeError(err: any) {
  return err.response?.status || err.cause?.code || err.code || "network";
}

// A fallback can itself carry a `.fallback` — recursing into complete() rather
// than calling completeAttempts() directly turns that into a real chain
// (HCAI -> Zen -> 9Router, say), not just one extra hop. Existing single-hop
// callers are unaffected: their fallback object has no `.fallback` of its own,
// so the recursive call's catch block just has nothing left to try.
async function complete(options: any, scope: any = "llm") {
  const { fallback, ...primary } = options;

  try {
    return await completeAttempts(primary, scope);
  } catch (err: any) {
    if (!fallback) throw err;
    log.warn(scope, `${primary.model || primary.baseUrl} failed (${describeError(err)}) — falling back to ${fallback.model || fallback.baseUrl}`);
    return await complete({ ...primary, ...fallback }, `${scope}-fallback`);
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
function parseSseChunk(buffer: any, { flush = false }: any = {}) {
  const deltas: any[] = [];
  const lines = buffer.split("\n");
  let rest = lines.pop();
  if (flush && rest) {
    lines.push(rest);
    rest = "";
  }
  let finishReason: any = null;

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame: any;
    try {
      frame = JSON.parse(payload);
    } catch {
      // A frame we can't read is one lost token, not a failed answer.
      continue;
    }
    const delta = frame?.choices?.[0]?.delta?.content;
    if (delta) deltas.push(delta);
    if (frame?.choices?.[0]?.finish_reason) finishReason = frame.choices[0].finish_reason;
  }

  return { deltas, rest, finishReason };
}

// One streaming attempt. `onDelta` is called with each fragment as it arrives;
// returning false from it stops the stream (used by the SILENT gate, which
// knows the answer is nothing after the very first token).
async function streamCompletion({ baseUrl, apiKey, model, messages, maxTokens, temperature, thinking, timeout }: any, onDelta: any) {
  const controller = new AbortController();
  // Armed against time-to-FIRST-token, not total duration: a stream that is
  // still producing text is healthy however long it runs, and killing it
  // mid-sentence would truncate a reply already visible in Slack.
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), timeout || DEFAULT_TIMEOUT_MS);
  const clearFirstTokenTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const usedKey = typeof apiKey === "function" ? apiKey() : apiKey;
  const filteredThinking = thinkingFor(model, thinking);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${usedKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(temperature === undefined ? {} : { temperature }),
        ...(filteredThinking === undefined ? {} : { thinking: filteredThinking }),
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err: any = new Error(`stream failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      err.response = { status: res.status };
      err.usedKey = usedKey;
      throw err;
    }
    if (!res.body) throw new Error("stream failed: no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let stopped = false;
    let insideThink = false;
    let thinkBuffer = "";
    let finishReason: any = null;

    const applyFrames = (frames: any) => {
      if (frames.finishReason) finishReason = frames.finishReason;
      for (const delta of frames.deltas) {
        clearFirstTokenTimer();

        const hasThinkOpen = (s: any) => /<(?:think|thinking|thought|scratchpad)>/i.test(s);
        const hasThinkClose = (s: any) => /<\/(?:think|thinking|thought|scratchpad)>/i.test(s);

        if (insideThink || hasThinkOpen(delta) || hasThinkOpen(thinkBuffer)) {
          insideThink = true;
          thinkBuffer += delta;
          if (hasThinkClose(thinkBuffer)) {
            insideThink = false;
            const parts = thinkBuffer.split(/<\/(?:think|thinking|thought|scratchpad)>/i);
            const remaining = parts.slice(1).join("");
            thinkBuffer = "";
            if (remaining) {
              text += remaining;
              if (onDelta && onDelta(remaining, text) === false) return true;
            }
          }
          continue;
        }

        text += delta;
        if (onDelta && onDelta(delta, text) === false) return true;
      }
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = parseSseChunk(buffer);
      buffer = frames.rest;
      stopped = applyFrames(frames);

      if (stopped) {
        controller.abort();
        break;
      }
    }

    buffer += decoder.decode();
    if (!stopped && buffer) applyFrames(parseSseChunk(buffer, { flush: true }));
    if (!stopped && finishReason !== "stop") {
      throw new Error(`stream ended without a complete answer (finish_reason=${finishReason || "missing"})`);
    }

    return { text, stopped, usedKey, finishReason };
  } finally {
    clearFirstTokenTimer();
  }
}

// Retries only when NOTHING was streamed. Once a fragment has been handed to
// onDelta it is already on screen, and a second attempt would rewrite the reply
// in front of whoever is reading it.
async function streamAttempts(options: any, onDelta: any, scope: any) {
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let streamed = false;
    const track = (delta: any, text: any) => {
      streamed = true;
      return onDelta ? onDelta(delta, text) : undefined;
    };

    try {
      const result = await streamCompletion(options, track);
      if (result.text.trim() || result.stopped) return result;
      log.debug(scope, `empty stream, attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
    } catch (err: any) {
      lastError = err;
      noteRateLimit(options, err);
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

async function completeStream(options: any, onDelta: any, scope: any = "llm") {
  const { fallback, ...primary } = options;

  // Tracked across attempts, not within one: the moment any text reaches Slack
  // the reply is visible, and a standby model would rewrite it mid-sentence in
  // front of whoever is reading. Falling back is only safe from silence.
  let streamedAny = false;
  const track = (delta: any, text: any) => {
    streamedAny = true;
    return onDelta ? onDelta(delta, text) : undefined;
  };

  try {
    return await streamAttempts(primary, track, scope);
  } catch (err: any) {
    if (!fallback || streamedAny) throw err;
    log.warn(scope, `${primary.model || primary.baseUrl} failed (${describeError(err)}) — falling back to ${fallback.model || fallback.baseUrl}`);
    // Recurses into completeStream() rather than streamAttempts() so a
    // fallback with its own `.fallback` chains further — see complete()'s
    // matching comment above.
    return await completeStream({ ...primary, ...fallback }, track, `${scope}-fallback`);
  }
}

export = {
  complete,
  completeStream,
  requestCompletion,
  streamCompletion,
  parseSseChunk,
  thinkingFor,
  isRetryableStatus,
  isRetryableError,
  stripThinking,
  keepAliveAgent,
  MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
};
