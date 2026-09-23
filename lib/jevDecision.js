// Decision/gating layer: TypeSafe Jev via Vercel AI Gateway.
//
// Pixie's own LLM still generates every support response. This module only
// answers "should Pixie act on this message given the supplied evidence?" and
// returns Pixie's own normalized SupportDecision. Vendor structures never
// leave this file.
//
// Fails closed: disabled, misconfigured, or errored evaluation never permits
// a reply. Callers fall back to the existing safe pipeline (escalate in the
// help channel, silence elsewhere) and never crash the Slack handler.
const { config, jevConfig } = require("./config");
const log = require("./log");

const JEV_MODEL_DEFAULT = "typesafe-ai/jev";
const MAX_MESSAGE_CHARS = 1000;
const MAX_CONTEXT_CHARS = 1500;

function truncate(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

function effectiveConfig() {
  try {
    const live = typeof jevConfig === "function" ? jevConfig() : null;
    if (live) return live;
  } catch (_) {}
  return config.jev;
}

function providerOf(cfg = effectiveConfig()) {
  return (cfg && cfg.provider) === "experiential" ? "experiential" : "vercel";
}

function providerKeyPresent(cfg = effectiveConfig()) {
  if (!cfg) return false;
  return providerOf(cfg) === "experiential" ? Boolean(cfg.experientialApiKeyPresent) : Boolean(cfg.gatewayApiKeyPresent);
}

function isEnabled(cfg = effectiveConfig()) {
  return Boolean(cfg && cfg.enabled && providerKeyPresent(cfg));
}

// Canary rollout gate: Jev is active only in explicitly listed channels. An
// empty/unset list matches nothing, so Jev can never roll out globally by
// accident. Pure — no I/O, safe to call on every message.
function isJevActiveForChannel(channel, cfg = effectiveConfig()) {
  if (!isEnabled(cfg)) return false;
  const list = (cfg && cfg.canaryChannels) || [];
  return Boolean(channel) && list.includes(channel);
}

function buildJevState({ message, conversationContext, program, channelPosture, addressed = false }) {
  const prog = program && typeof program === "object"
    ? { id: program.id || null, name: program.name || null, posture: program.posture || null, scope: program.scope || null }
    : { id: typeof program === "string" ? program : null, name: null, posture: null, scope: null };
  return {
    message: truncate(message, MAX_MESSAGE_CHARS),
    conversationContext: truncate(conversationContext, MAX_CONTEXT_CHARS),
    program: prog,
    channelPosture: channelPosture === "help" ? "help" : "program",
    addressed: Boolean(addressed),
  };
}

const INTENT_CHOICES = {
  support_question: "A clear request for program help or a factual program/support question.",
  direct_program_question: "A clear question about the program, its process, policy, grants, shipping, submissions, or participation.",
  addressed_smalltalk: "The sender directly addresses Pixie for greeting, thanks, or light conversation.",
  ambiguous_followup: "A follow-up whose meaning depends on a clear recent or thread referent.",
  unrelated_chatter: "A reaction, joke, unrelated chat, or message Pixie should not enter.",
  human_conversation: "Humans talking to each other rather than asking Pixie for help.",
};

function buildJevQuestions() {
  return {
    intent: {
      type: "choice",
      instructions: "Classify only whether Pixie should engage. Do not judge documentation, factual accuracy, answer risk, policies, numbers, or whether a human must answer; retrieval and grounding handle all answerability after this step. In a help channel, genuine support questions usually engage without a mention. In a normal program channel, clear program/support questions engage, but ordinary human conversation stays silent. A direct address strongly favors engagement. An ambiguous follow-up engages only when the supplied conversation context clearly identifies its referent.",
      criteria: INTENT_CHOICES,
    },
    shouldEngage: {
      type: "boolean",
      instructions: "Should Pixie continue to retrieval for this message? Judge only conversational intent using the message, bounded context, channel posture, and direct-address flag. Never use documentation sufficiency, factual risk, or missing policy facts as a reason to deny engagement.",
      criteria: { true: "A clear support/program question, a directly addressed request, or an ambiguous follow-up with a clear referent.", false: "Unrelated chatter, human conversation, or an ambiguous follow-up without a clear referent." },
    },
  };
}

function probOf(answer) {
  const p = answer && typeof answer.probability === "number" ? answer.probability : null;
  return typeof p === "number" && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null;
}

function boolFrom(answer) {
  const p = probOf(answer);
  if (p === null) return { value: false, confidence: undefined };
  return { value: p >= 0.5, confidence: p >= 0.5 ? p : 1 - p };
}

function parseEvaluationResult(result) {
  const answers = (result && result.answers) || {};
  const engage = boolFrom(answers.shouldEngage);
  const intent = answers.intent && typeof answers.intent.choice === "string" && Object.hasOwn(INTENT_CHOICES, answers.intent.choice)
    ? answers.intent.choice : null;
  return {
    intent,
    shouldEngage: engage.value,
    confidence: {
      ...(engage.confidence !== undefined ? { shouldEngage: engage.confidence } : {}),
      ...(answers.intent ? { intent: maxProb(answers.intent.probabilities) } : {}),
    },
    probabilities: {
      ...(probOf(answers.shouldEngage) !== null ? { shouldEngage: probOf(answers.shouldEngage) } : {}),
    },
    source: "jev",
  };
}

function maxProb(probs) {
  if (!probs || typeof probs !== "object") return undefined;
  const vals = Object.values(probs).filter((v) => typeof v === "number" && Number.isFinite(v));
  return vals.length > 0 ? Math.max(...vals) : undefined;
}

function fallbackDecision() {
  return {
    intent: null,
    shouldEngage: false,
    confidence: {},
    probabilities: {},
    source: "fallback",
  };
}

function decideAction(decision, cfg = effectiveConfig(), { inHelpChannel = false } = {}) {
  if (!decision || decision.source === "existing") return { action: "existing", reason: "jev_disabled" };
  const engageP = decision.probabilities?.shouldEngage;
  const threshold = Number.isFinite(cfg.engageThreshold) ? cfg.engageThreshold : 0.7;
  if (decision.shouldEngage && engageP !== undefined && engageP >= threshold) return { action: "engage", reason: "jev_engage" };
  void inHelpChannel;
  return { action: "silence", reason: "jev_deny" };
}

const ERROR_KINDS = new Set(["auth", "quota", "rate_limit", "timeout", "bad_response", "unavailable", "network", "other", "unknown"]);

function classifyError(err) {
  if (!err) return "unknown";
  // Provider adapters pre-classify their own failures; trust that label since
  // it was assigned next to the status code and body that produced it.
  if (err.jevErrorKind && ERROR_KINDS.has(err.jevErrorKind)) return err.jevErrorKind;
  if (err.name === "AbortError" || /abort|timeout|timed out/i.test(err.message || "")) return "timeout";
  // The SDK wraps gateway failures in AI_RetryError ("Failed after N attempts.
  // Last error: GatewayRateLimitError: ...") with no statusCode on the outer
  // error, so name+message matching is the only reliable rate-limit signal.
  if (/rate.?limit/i.test(`${err.name || ""} ${err.message || ""}`)) return "rate_limit";
  const status = err.status || err.statusCode || err.response?.status;
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider";
  if (/network|fetch|socket|econn|enotfound|eai_again/i.test(err.message || "") || err.code) {
    if (!status) return "network";
  }
  if (/parse|valid|schema|unsupported/i.test(err.message || "")) return "bad_response";
  if (/api key|gateway/i.test(err.message || "")) return "unavailable";
  return "unknown";
}

async function realEvaluate({ state, questions, timeoutMs, model, zeroDataRetention }) {
  let sdk;
  try {
    sdk = require("ai");
  } catch (e) {
    throw Object.assign(new Error(`ai SDK unavailable: ${e.message}`), { code: "E_AI_SDK" });
  }
  const evaluate = sdk.experimental_evaluate || sdk.evaluate;
  const gw = sdk.gateway;
  if (typeof evaluate !== "function") throw new Error("ai SDK has no experimental_evaluate");
  if (!gw || typeof gw.evaluationModel !== "function") throw new Error("ai gateway has no evaluationModel");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`jev timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await evaluate({
      model: gw.evaluationModel(model || JEV_MODEL_DEFAULT),
      state,
      questions,
      abortSignal: controller.signal,
      ...(zeroDataRetention === false ? {} : { providerOptions: { gateway: { zeroDataRetention: true } } }),
    });
  } finally {
    clearTimeout(timer);
  }
}

// Short-lived result cache + in-flight dedupe so the same Slack event (or a
// retry/follow-up with identical evidence) does not pay for repeated Jev
// calls under free-tier rate limits. Only successful evaluations (source jev)
// are cached; failures always re-evaluate so a transient outage can never pin
// a stale deny or permit in place. TTL is deliberately short: corpus and
// thread context move underneath the key within minutes.
const decisionCache = new Map();
const inflightEvaluations = new Map();
const jevStats = { calls: 0, cacheHits: 0 };

function jevCacheTtlMs(cfg) {
  const n = Number(process.env.JEV_CACHE_TTL_MS);
  if (Number.isFinite(n) && n > 0) return n;
  void cfg;
  return 120 * 1000;
}

function experientialApiKey() {
  // Read at call time and never stored: the key must not land in the config
  // object, logs, or metrics.
  return (process.env.EXPERIENTIAL_API_KEY || "").trim() || null;
}

function cacheKeyFor({ provider, model, state }) {
  const fingerprint = JSON.stringify({
    provider,
    model,
    message: state.message,
    conversationContext: state.conversationContext,
    program: state.program,
    channelPosture: state.channelPosture,
    addressed: state.addressed,
  });
  return require("crypto").createHash("sha256").update(fingerprint).digest("hex");
}

function getStats() {
  return { ...jevStats };
}

function clearDecisionCache() {
  decisionCache.clear();
  inflightEvaluations.clear();
}

function logDecision({ decision, action, reason, latencyMs, errorKind, enabled, provider, model }) {
  const c = decision?.confidence || {};
  const p = decision?.probabilities || {};
  const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "?");
  log.info(
    "jev",
    `[jev] enabled=${enabled} provider=${provider || "?"} model=${model || "?"} jev_intent=${decision?.intent || "?"} ` +
      `jev_should_engage=${decision?.shouldEngage} ${fmt(p.shouldEngage)} final_action=${action} reason=${reason} latency_ms=${latencyMs}${errorKind ? ` error=${errorKind}` : ""}`,
  );
  void c;
}

// One clear abstraction for the rest of Pixie. Never throws: failures return
// a conservative fallback decision so callers stay on the safe path.
async function evaluateSupportDecision(
  { message, conversationContext = "", program = null, channelPosture = "program", addressed = false } = {},
  deps = {},
) {
  const cfg = deps.config || effectiveConfig();
  const startedAt = Date.now();
  if (!isEnabled(cfg)) {
    return {
      decision: { ...(deps.fallbackDecision || fallbackDecision()), source: "existing" },
      action: "existing",
      reason: "jev_disabled",
      latencyMs: Date.now() - startedAt,
      errorKind: null,
    };
  }
  const state = buildJevState({ message, conversationContext, program, channelPosture, addressed });
  const questions = deps.questions || buildJevQuestions();
  const provider = providerOf(cfg);
  const model = deps.model || cfg.model;
  // Backend selection is exclusive: experiential mode never touches the Vercel
  // SDK and vercel mode never touches the Experiential endpoint. There is no
  // cross-provider fallback — any failure below fails closed.
  let evaluateFn = deps.evaluateFn || null;
  if (!evaluateFn) {
    if (provider === "experiential") {
      const experiential = require("./jevExperiential");
      evaluateFn = (args) =>
        experiential.experientialEvaluate(
          {
            baseUrl: cfg.baseUrl,
            apiKey: experientialApiKey(),
            model: args.model,
            state: args.state,
            questions: args.questions,
            timeoutMs: args.timeoutMs,
          },
          { httpPost: deps.httpPost },
        );
    } else {
      evaluateFn = realEvaluate;
    }
  }
  // Injected stubs (tests, harness overrides) bypass the cache: they are
  // already free and must observe every call.
  const cacheable = !deps.evaluateFn && !deps.questions;
  const key = cacheable ? cacheKeyFor({ provider, model, state }) : null;
  if (key) {
    const hit = decisionCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      jevStats.cacheHits += 1;
      try {
        require("./db").recordMetric("jev_cache_hit", 0, hit.result.action || null, program?.id || null);
      } catch (_) {}
      log.info("jev", `[jev] cached=true action=${hit.result.action} reason=${hit.result.reason}`);
      return { ...hit.result, latencyMs: 0, cached: true };
    }
    if (inflightEvaluations.has(key)) return inflightEvaluations.get(key);
  }
  const run = (async () => {
    try {
      const result = await evaluateFn({
        state,
        questions,
        timeoutMs: deps.timeoutMs || cfg.timeoutMs,
        model,
        // Vercel-only flag. The Experiential adapter never receives it (and
        // its endpoint would reject unknown provider options).
        zeroDataRetention: provider === "vercel" ? cfg.zeroDataRetention : false,
      });
      // Experiential answers arrive pre-translated to the shared vocabulary
      // by lib/jevExperiential.js, so one parser serves both backends.
      const decision = parseEvaluationResult(result);
      const { action, reason } = decideAction(decision, cfg, { inHelpChannel: channelPosture === "help" });
      const latencyMs = Date.now() - startedAt;
      logDecision({ decision, action, reason, latencyMs, errorKind: null, enabled: true, provider, model });
      try {
        require("./db").recordMetric("jev_decision", latencyMs, `${action}:${reason}`, program?.id || null);
      } catch (_) {}
      const outcome = { decision, action, reason, latencyMs, errorKind: null };
      if (key) {
        jevStats.calls += 1;
        decisionCache.set(key, { expiresAt: Date.now() + jevCacheTtlMs(cfg), result: outcome });
      }
      return outcome;
    } catch (err) {
      throw err;
    } finally {
      if (key) inflightEvaluations.delete(key);
    }
  })();
  if (key) inflightEvaluations.set(key, run);
  try {
    return await run;
  } catch (err) {
    const errorKind = classifyError(err);
    const decision = fallbackDecision();
    const latencyMs = Date.now() - startedAt;
    const action = channelPosture === "help" ? "escalate" : "silence";
    const reason = `jev_error_${errorKind}`;
    logDecision({ decision, action, reason, latencyMs, errorKind, enabled: true, provider: providerOf(cfg), model: deps.model || cfg.model });
    try {
      require("./db").recordMetric("jev_error", latencyMs, errorKind, program?.id || null);
    } catch (_) {}
    return { decision, action, reason, latencyMs, errorKind };
  }
}

module.exports = {
  evaluateSupportDecision,
  isJevActiveForChannel,
  providerOf,
  providerKeyPresent,
  experientialApiKey,
  getStats,
  clearDecisionCache,
  buildJevState,
  buildJevQuestions,
  parseEvaluationResult,
  decideAction,
  isEnabled,
  effectiveConfig,
  fallbackDecision,
  classifyError,
  JEV_MODEL_DEFAULT,
  MAX_MESSAGE_CHARS,
  MAX_CONTEXT_CHARS,
  INTENT_CHOICES,
};
