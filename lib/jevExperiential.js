// Experiential Labs native adapter: one POST to /v1/systemone per call.
//
// Wire shapes follow the public System One protocol (noul/choice/score):
//   request  { model, state, questions }
//   response { model, answers: { id: answer }, usage }
//   noul   question {type,instructions,criteria?} → answer {type:'noul', noul: P(yes)}
//   choice question {criteria:{name:desc}}       → answer {choice, probabilities, confidence}
//   score  question {criteria:[levels]}          → answer {score (0-based), legend, probabilities, confidence}
//
// Free-lane-only billing rule, enforced by construction:
// - exactly one HTTP attempt per evaluation (no retries that could burn quota
//   or spill into metered lanes),
// - never switches model, endpoint, or provider — there is no fallback path
//   in this module or anywhere above it,
// - every provider-side refusal (quota, rate limit, auth, overload, timeout,
//   malformed) throws a classified error that the caller turns into the
//   existing fail-closed fallback (abstain/escalate, never a paid retry).
//
// Score workaround: the Experiential host's native score path is unreliable
// (intermittent Cloudflare 502s on any batch containing a score question,
// while noul/choice batches serve 200). Score questions are therefore sent as
// a 5-way choice with fixed risk_N categories and mapped back to the shared
// 1-5 risk scale. Native score ANSWERS are still validated when received
// (diagnostic path), but a score question is never emitted here.
const axios = require("axios");

const RISK_CHOICE_CRITERIA = {
  risk_1: "The answer is explicitly and directly supported by the supplied authoritative evidence.",
  risk_2: "The answer is strongly supported by the supplied evidence and requires only minor interpretation.",
  risk_3: "The evidence is materially incomplete, ambiguous, or requires assumptions.",
  risk_4: "The answer is weakly supported and would likely require unsupported inference.",
  risk_5: "The answer is not supported by the supplied evidence and would likely be fabricated.",
};

const RISK_CHOICE_RE = /^risk_([1-5])$/;

const QUOTA_RES = /free_limit|insufficient_quota|quota|promotion|billing|payment|past_due/i;

function fail(kind, message, status = null) {
  const err = new Error(message);
  err.jevErrorKind = kind;
  if (status !== null && status !== undefined) err.status = status;
  return err;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Our internal question vocabulary uses `boolean`; the wire uses `noul`.
// Criteria ({true,false} descriptions, choice map, score levels) pass through
// untouched — thresholds and exact-fact hardening live in lib/jevDecision.js.
function toWireQuestions(questions) {
  const wire = {};
  for (const [id, q] of Object.entries(questions || {})) {
    if (!q || typeof q !== "object") throw fail("bad_response", `question ${id} is not an object`);
    if (q.type === "boolean") {
      wire[id] = { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
    } else if (q.type === "choice") {
      wire[id] = { type: q.type, instructions: q.instructions, criteria: q.criteria };
    } else if (q.type === "score") {
      // Never emit native score: send the fixed risk choice instead.
      wire[id] = { type: "choice", instructions: q.instructions, criteria: RISK_CHOICE_CRITERIA };
    } else {
      throw fail("bad_response", `question ${id} has unsupported type ${q.type}`);
    }
  }
  return wire;
}

function checkRiskChoice(id, answer) {
  const m = typeof answer.choice === "string" ? answer.choice.match(RISK_CHOICE_RE) : null;
  if (!m) throw fail("bad_response", `answer ${id} selects an undeclared risk level`);
  if (answer.probabilities !== undefined) {
    if (!answer.probabilities || typeof answer.probabilities !== "object") throw fail("bad_response", `answer ${id} has invalid probabilities`);
    for (const v of Object.values(answer.probabilities)) {
      if (finiteNumber(v) === null) throw fail("bad_response", `answer ${id} has invalid probabilities`);
    }
  }
  // risk_N → shared 0-based score scale (risk N). Probabilities pass through
  // untouched so confidence is always the model's own distribution, never
  // invented; absent probabilities mean absent confidence downstream.
  return { type: "score", score: Number(m[1]) - 1, ...(answer.probabilities ? { probabilities: answer.probabilities } : {}) };
}

function checkNoul(id, answer) {
  const p = finiteNumber(answer.noul);
  if (p === null || p < 0 || p > 1) throw fail("bad_response", `answer ${id} has invalid noul probability`);
  return { type: "boolean", probability: p };
}

function checkChoice(id, question, answer) {
  const options = question.criteria && typeof question.criteria === "object" ? Object.keys(question.criteria) : [];
  if (typeof answer.choice !== "string" || !options.includes(answer.choice)) {
    throw fail("bad_response", `answer ${id} selects an undeclared option`);
  }
  if (answer.probabilities !== undefined) {
    if (!answer.probabilities || typeof answer.probabilities !== "object") throw fail("bad_response", `answer ${id} has invalid probabilities`);
    for (const [k, v] of Object.entries(answer.probabilities)) {
      if (!options.includes(k) || finiteNumber(v) === null) throw fail("bad_response", `answer ${id} has invalid probabilities`);
    }
  }
  return { type: "choice", choice: answer.choice, ...(answer.probabilities ? { probabilities: answer.probabilities } : {}) };
}

function checkScore(id, question, answer) {
  const levels = Array.isArray(question.criteria) ? question.criteria.length : 0;
  const s = finiteNumber(answer.score);
  if (s === null || levels < 2 || s < 0 || s > levels - 1) throw fail("bad_response", `answer ${id} has out-of-range score`);
  if (answer.probabilities !== undefined) {
    if (!answer.probabilities || typeof answer.probabilities !== "object") throw fail("bad_response", `answer ${id} has invalid probabilities`);
    for (const v of Object.values(answer.probabilities)) {
      if (finiteNumber(v) === null) throw fail("bad_response", `answer ${id} has invalid probabilities`);
    }
  }
  return { type: "score", score: s, ...(answer.probabilities ? { probabilities: answer.probabilities } : {}) };
}

// Strict: one translated answer per asked question, types must match, numbers
// must be finite and in range. Anything else throws bad_response → fail closed.
function toInternalAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw fail("bad_response", "response has no answers map");
  const out = {};
  for (const [id, q] of Object.entries(questions || {})) {
    const answer = answers[id];
    if (!answer || typeof answer !== "object") throw fail("bad_response", `missing answer for ${id}`);
    if (q.type === "boolean" && answer.type === "noul") out[id] = checkNoul(id, answer);
    else if (q.type === "choice" && answer.type === "choice") out[id] = checkChoice(id, q, answer);
    else if (q.type === "score" && answer.type === "choice") out[id] = checkRiskChoice(id, answer);
    // Diagnostic path only: native score answers validate but are never
    // requested by production Experiential evaluations (see toWireQuestions).
    else if (q.type === "score" && answer.type === "score") out[id] = checkScore(id, q, answer);
    else throw fail("bad_response", `answer ${id} type mismatch`);
  }
  return out;
}

function classifyHttpStatus(status, data) {
  const bodyText = JSON.stringify(data || {}).slice(0, 300);
  if (status === 401 || status === 403) return fail("auth", `experiential rejected credentials (http ${status})`, status);
  if (status === 402 || QUOTA_RES.test(bodyText)) return fail("quota", `experiential free usage exhausted (${bodyText.slice(0, 120)})`, status);
  if (status === 429) return fail("rate_limit", `experiential rate limited (http 429)`, status);
  if (status === 422) return fail("bad_response", `experiential rejected request shape (http 422): ${bodyText.slice(0, 120)}`, status);
  if (status >= 500) return fail("unavailable", `experiential unavailable (http ${status})`, status);
  return fail("bad_response", `experiential unexpected status (http ${status})`, status);
}

async function defaultHttpPost(url, body, { headers, timeoutMs, apiKey }) {
  // Key travels only in the Authorization header of this single request. It
  // is never logged, metered, or stored — see lib/jevDecision.js logging.
  // Required here (not in experientialEvaluate) so injected test transports
  // never need real credentials.
  if (!apiKey) throw fail("auth", "experiential api key missing");
  const res = await axios.post(url, body, {
    headers: { ...headers, Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    timeout: timeoutMs,
    maxRedirects: 0,
  });
  return { status: res.status, data: res.data };
}

async function experientialEvaluate({ baseUrl, apiKey, model, state, questions, timeoutMs = 8000 } = {}, deps = {}) {
  if (!model) throw fail("bad_response", "experiential model missing");
  const url = String(baseUrl || "").replace(/\/+$/, "") || "https://api.experientiallabs.ai/v1/systemone";
  const wireQuestions = toWireQuestions(questions);
  const httpPost = deps.httpPost || defaultHttpPost;
  let res;
  try {
    res = await httpPost(url, { model, state, questions: wireQuestions }, { headers: {}, timeoutMs, apiKey });
  } catch (err) {
    if (err && err.jevErrorKind) throw err;
    const status = err?.response?.status ?? err?.status;
    if (typeof status === "number") throw classifyHttpStatus(status, err?.response?.data);
    if (/timeout|timed out|abort|ECONNABORTED/i.test(err?.message || err?.code || "")) {
      throw fail("timeout", `experiential request timed out after ${timeoutMs}ms`);
    }
    throw fail("unavailable", `experiential unreachable (${(err && (err.code || err.message) || "network").toString().slice(0, 80)})`);
  }
  if (!res || typeof res.status !== "number") throw fail("bad_response", "experiential transport returned no status");
  if (res.status < 200 || res.status >= 300) throw classifyHttpStatus(res.status, res.data);
  const body = res.data;
  if (!body || typeof body !== "object") throw fail("bad_response", "experiential returned no body");
  return {
    model: body.model || model,
    answers: toInternalAnswers(questions, body.answers),
    usage: body.usage && typeof body.usage === "object" ? body.usage : {},
  };
}

module.exports = { experientialEvaluate, toWireQuestions, toInternalAnswers, classifyHttpStatus, RISK_CHOICE_CRITERIA };
