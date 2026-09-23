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
const MAX_DOCS_CHARS = 4000;

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

function buildJevState({ message, conversationContext, program, retrievedDocumentation, retrievalMetadata, currentIntent }) {
  const prog = program && typeof program === "object"
    ? { id: program.id || null, name: program.name || null, posture: program.posture || null, scope: program.scope || null }
    : { id: typeof program === "string" ? program : null, name: null, posture: null, scope: null };
  return {
    message: truncate(message, MAX_MESSAGE_CHARS),
    conversationContext: truncate(conversationContext, MAX_CONTEXT_CHARS),
    program: prog,
    retrievedDocumentation: truncate(retrievedDocumentation, MAX_DOCS_CHARS),
    retrievalMetadata: retrievalMetadata && typeof retrievalMetadata === "object" ? retrievalMetadata : {},
    currentIntent: currentIntent === undefined || currentIntent === null ? null : String(currentIntent).slice(0, 80),
  };
}

const GROUNDING_PREAMBLE = [
  "Judge ONLY the supplied state/evidence. Absence of evidence means insufficient evidence.",
  "Do not use outside knowledge and do not treat plausible information as documented information.",
  "Conflicting documentation increases uncertainty. Do not assume policies or program rules.",
  "Grants, payouts, eligibility, review decisions, program rules, deadlines, shipping, taxes,",
  "financial decisions, and organizer-specific policies need explicit documentation to answer.",
].join(" ");

function buildJevQuestions({ escalationCategories = [] } = {}) {
  const questions = {
    isSupportQuestion: {
      type: "boolean",
      instructions: `${GROUNDING_PREAMBLE} Is this message actually a support/question/request that Pixie is supposed to handle? Random conversation, jokes, chatter, reactions, and discussions between humans are not support questions.`,
      criteria: {
        true: "The message asks for help, asks a program question, or requests something Pixie handles.",
        false: "Chatter, jokes, reactions, venting with no request, or human-to-human discussion.",
      },
    },
    documentationIsSufficient: {
      type: "boolean",
      instructions:
        `${GROUNDING_PREAMBLE} Does the supplied retrievedDocumentation actually contain enough authoritative information to answer the message? Judge the PROVIDED evidence only. No docs means insufficient. ` +
        `EXACT-FACT RULE: if the message asks for an exact numeric or policy fact — a percentage, amount, deadline, date, duration, eligibility requirement, payout, rate, limit, threshold, or any other precise rule or number — this is false unless that EXACT fact, with the same value and unit, appears explicitly in retrievedDocumentation. ` +
        `A section that merely discusses the topic (an AI policy with no number, payout explanations without the asked amount, timelines without the asked date) is topical coverage, not sufficiency, and must count as false.`,
      criteria: {
        true: "The docs state the exact asked fact explicitly, with enough detail to answer.",
        false: "Missing, vague, ambiguous, or conflicting docs; topical coverage without the exact fact; the answer would need guessing.",
      },
    },
    shouldReply: {
      type: "boolean",
      instructions: `${GROUNDING_PREAMBLE} Should Pixie autonomously respond given the message, conversation, program, and retrieved documentation? Require strong evidence; when in doubt the answer is no.`,
      criteria: {
        true: "Safe and useful for Pixie to reply now from the supplied evidence.",
        false: "Pixie should stay silent or hand to a human instead.",
      },
    },
    needsHuman: {
      type: "boolean",
      instructions: `${GROUNDING_PREAMBLE} Does this situation require a human because docs/context are missing, conflicting, ambiguous, program-policy-specific, or otherwise insufficient?`,
      criteria: {
        true: "A human should handle it; Pixie must not answer confidently.",
        false: "No human needed; the supplied evidence settles it.",
      },
    },
    answerRisk: {
      type: "score",
      instructions: `${GROUNDING_PREAMBLE} Rate the risk that answering from the provided information would produce unsupported or fabricated information. Exact numbers, dates, and policy outcomes stated without explicit doc support are risk 5.`,
      criteria: [
        "1 = clearly supported by the supplied docs",
        "2 = mostly supported, minor inference",
        "3 = ambiguous, key detail missing or unclear",
        "4 = weak evidence, would need guessing",
        "5 = likely unsupported, should not answer",
      ],
    },
  };
  const cats = [...new Set((escalationCategories || []).filter(Boolean))].slice(0, 8);
  if (cats.length >= 2) {
    const criteria = {};
    for (const c of cats) criteria[c] = `Route to the existing ${c} category.`;
    questions.escalationTarget = { type: "choice", instructions: "If a human must handle this, which EXISTING configured category fits best? Choose only among the listed categories.", criteria };
  }
  return questions;
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

function riskFrom(answer) {
  if (!answer || typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
    return { value: 5, confidence: undefined };
  }
  const clamped = Math.min(4, Math.max(0, answer.score));
  let confidence;
  if (answer.probabilities && typeof answer.probabilities === "object") {
    const vals = Object.values(answer.probabilities).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (vals.length > 0) confidence = Math.max(...vals);
  }
  return { value: clamped + 1, confidence };
}

function parseEvaluationResult(result) {
  const answers = (result && result.answers) || {};
  const support = boolFrom(answers.isSupportQuestion);
  const docs = boolFrom(answers.documentationIsSufficient);
  const reply = boolFrom(answers.shouldReply);
  const human = boolFrom(answers.needsHuman);
  const risk = riskFrom(answers.answerRisk);
  const target = answers.escalationTarget && typeof answers.escalationTarget.choice === "string"
    ? { value: answers.escalationTarget.choice, confidence: maxProb(answers.escalationTarget.probabilities) }
    : { value: null, confidence: undefined };
  return {
    isSupportQuestion: support.value,
    documentationIsSufficient: docs.value,
    shouldReply: reply.value,
    needsHuman: human.value,
    risk: risk.value,
    escalationTarget: target.value,
    confidence: {
      ...(support.confidence !== undefined ? { isSupportQuestion: support.confidence } : {}),
      ...(docs.confidence !== undefined ? { documentationIsSufficient: docs.confidence } : {}),
      ...(reply.confidence !== undefined ? { shouldReply: reply.confidence } : {}),
      ...(human.confidence !== undefined ? { needsHuman: human.confidence } : {}),
      ...(risk.confidence !== undefined ? { risk: risk.confidence } : {}),
      ...(target.confidence !== undefined ? { escalationTarget: target.confidence } : {}),
    },
    probabilities: {
      ...(probOf(answers.isSupportQuestion) !== null ? { isSupportQuestion: probOf(answers.isSupportQuestion) } : {}),
      ...(probOf(answers.documentationIsSufficient) !== null ? { documentationIsSufficient: probOf(answers.documentationIsSufficient) } : {}),
      ...(probOf(answers.shouldReply) !== null ? { shouldReply: probOf(answers.shouldReply) } : {}),
      ...(probOf(answers.needsHuman) !== null ? { needsHuman: probOf(answers.needsHuman) } : {}),
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
    isSupportQuestion: false,
    documentationIsSufficient: false,
    shouldReply: false,
    needsHuman: true,
    risk: 5,
    escalationTarget: null,
    confidence: {},
    probabilities: {},
    source: "fallback",
  };
}

function decideAction(decision, cfg = effectiveConfig(), { inHelpChannel = false } = {}) {
  if (!decision || decision.source === "existing") return { action: "existing", reason: "jev_disabled" };
  const supportP = decision.probabilities?.isSupportQuestion;
  const docsP = decision.probabilities?.documentationIsSufficient;
  const replyP = decision.probabilities?.shouldReply;
  const humanP = decision.probabilities?.needsHuman;
  const permit =
    decision.isSupportQuestion === true && supportP !== undefined && supportP >= cfg.supportThreshold &&
    decision.documentationIsSufficient === true && docsP !== undefined && docsP >= cfg.docsThreshold &&
    decision.shouldReply === true && replyP !== undefined && replyP >= cfg.replyThreshold &&
    decision.needsHuman === false && humanP !== undefined && humanP < cfg.humanThreshold &&
    typeof decision.risk === "number" && decision.risk <= cfg.maxRisk;
  if (permit) return { action: "reply", reason: "jev_permit" };
  const humanConfident = decision.needsHuman === true && humanP !== undefined && humanP >= cfg.humanThreshold;
  const supportConfident = decision.isSupportQuestion === true && supportP !== undefined && supportP >= cfg.supportThreshold;
  if (humanConfident || (supportConfident && decision.documentationIsSufficient === false)) {
    return { action: inHelpChannel ? "escalate" : "silence", reason: humanConfident ? "jev_needs_human" : "jev_insufficient_docs" };
  }
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

function cacheKeyFor({ provider, model, state, inHelpChannel, escalationCategories }) {
  const fingerprint = JSON.stringify({
    provider,
    model,
    message: state.message,
    conversationContext: state.conversationContext,
    program: state.program,
    retrievedDocumentation: state.retrievedDocumentation,
    retrievalMetadata: state.retrievalMetadata,
    currentIntent: state.currentIntent,
    inHelpChannel: Boolean(inHelpChannel),
    escalationCategories: [...(escalationCategories || [])].sort(),
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
    `[jev] enabled=${enabled} provider=${provider || "?"} model=${model || "?"} support=${decision?.isSupportQuestion} ${fmt(p.isSupportQuestion)} ` +
      `docs_sufficient=${decision?.documentationIsSufficient} ${fmt(p.documentationIsSufficient)} ` +
      `should_reply=${decision?.shouldReply} ${fmt(p.shouldReply)} ` +
      `needs_human=${decision?.needsHuman} ${fmt(p.needsHuman)} ` +
      `risk=${typeof decision?.risk === "number" ? decision.risk.toFixed(1) : "?"} ` +
      `action=${action} reason=${reason} latency_ms=${latencyMs}${errorKind ? ` error=${errorKind}` : ""}`,
  );
  void c;
}

// One clear abstraction for the rest of Pixie. Never throws: failures return
// a conservative fallback decision so callers stay on the safe path.
async function evaluateSupportDecision(
  { message, conversationContext = "", program = null, retrievedDocumentation = "", retrievalMetadata = {}, currentIntent = null, inHelpChannel = false, escalationCategories = [] } = {},
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
  const state = buildJevState({ message, conversationContext, program, retrievedDocumentation, retrievalMetadata, currentIntent });
  const questions = deps.questions || buildJevQuestions({ escalationCategories });
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
  const key = cacheable ? cacheKeyFor({ provider, model, state, inHelpChannel, escalationCategories }) : null;
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
      const { action, reason } = decideAction(decision, cfg, { inHelpChannel });
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
    const action = inHelpChannel ? "escalate" : "silence";
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
  MAX_DOCS_CHARS,
};
