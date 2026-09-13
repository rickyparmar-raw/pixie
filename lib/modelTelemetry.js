// Product telemetry for model calls: token usage, cost, provider attribution.
//
// Split out of lib/llm.js without behavior change. llm.js keeps the transport
// (complete/completeStream/requestCompletion/streamCompletion/parseSseChunk and
// friends) and delegates here for everything usage/cost/provider. This module
// owns the db/log/crypto requires for telemetry; llm.js keeps its own log and
// crypto requires because the transport still uses both (requestId, logging).
const db = require("./db");
const log = require("./log");
const crypto = require("crypto");

function usageFor(data) {
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

function costFor(model, usage) {
  let prices = { ...KNOWN_PRICING };
  try { prices = { ...KNOWN_PRICING, ...JSON.parse(process.env.PIXIE_LLM_PRICING_JSON || "{}") }; } catch (_) { prices = { ...KNOWN_PRICING }; }
  const price = prices[model];
  if (!price || usage.promptTokens === null || usage.completionTokens === null) return null;
  return (usage.promptTokens * Number(price.input || 0) + usage.completionTokens * Number(price.output || 0)) / 1000000;
}

function recordUsage(options, result = {}) {
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
  } catch (e) {
    log.debug("llm", `telemetry failed: ${e.message}`);
  }
}

function providerFor(baseUrl) {
  try { return new URL(baseUrl).hostname || null; } catch (_) { return null; }
}

module.exports = {
  usageFor,
  costFor,
  providerFor,
  recordUsage,
  KNOWN_PRICING,
};
