// Native Experiential Labs adapter; provider-specific wire shapes stay inside this module.
import axios = require("axios");

type QuestionType = "boolean" | "choice" | "score";
interface Question {
  type: QuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
}
interface WireQuestion {
  type: string;
  instructions: string;
  criteria?: Record<string, string> | string[];
}
type Questions = Record<string, Question>;
interface Answer {
  type?: string;
  choice?: string;
  noul?: unknown;
  score?: unknown;
  probabilities?: Record<string, unknown>;
}
interface HttpResponse {
  status: number;
  data: unknown;
}
type HttpPost = (
  url: string,
  body: unknown,
  options: { headers: Record<string, string>; timeoutMs: number; apiKey: string | null },
) => Promise<HttpResponse>;
interface AdapterDeps {
  httpPost?: HttpPost;
}
interface ClassifiedError extends Error {
  jevErrorKind: string;
  status?: number;
}

const RISK_CHOICE_CRITERIA = {
  risk_1: "The answer is explicitly and directly supported by the supplied authoritative evidence.",
  risk_2: "The answer is strongly supported by the supplied evidence and requires only minor interpretation.",
  risk_3: "The evidence is materially incomplete, ambiguous, or requires assumptions.",
  risk_4: "The answer is weakly supported and would likely require unsupported inference.",
  risk_5: "The answer is not supported by the supplied evidence and would likely be fabricated.",
};

const RISK_CHOICE_RE = /^risk_([1-5])$/;

const QUOTA_RES = /free_limit|insufficient_quota|quota|promotion|billing|payment|past_due/i;

function fail(kind: string, message: string, status: number | null = null): ClassifiedError {
  const err = new Error(message) as ClassifiedError;
  err.jevErrorKind = kind;
  if (status !== null && status !== undefined) err.status = status;
  return err;
}

function isFreeModel(model: unknown): boolean {
  return typeof model === "string" && /[:-]free$/.test(model.trim());
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toWireQuestions(questions: Questions = {}): Record<string, WireQuestion> {
  const wire: Record<string, WireQuestion> = {};
  // Convert internal boolean questions to the provider's "noul" wire type.
  for (const [id, q] of Object.entries(questions || {})) {
    if (!q || typeof q !== "object") throw fail("bad_response", `question ${id} is not an object`);
    if (q.type === "boolean") {
      wire[id] = { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
    } else if (q.type === "choice") {
      wire[id] = { type: q.type, instructions: q.instructions, criteria: q.criteria };
    } else if (q.type === "score") {
      wire[id] = { type: "choice", instructions: q.instructions, criteria: RISK_CHOICE_CRITERIA };
    } else {
      throw fail("bad_response", `question ${id} has unsupported type ${q.type}`);
    }
  }
  return wire;
}

function checkRiskChoice(
  id: string,
  answer: Answer,
): { type: "score"; score: number; probabilities?: Record<string, unknown> } {
  const m = typeof answer.choice === "string" ? answer.choice.match(RISK_CHOICE_RE) : null;
  if (!m) throw fail("bad_response", `answer ${id} selects an undeclared risk level`);
  if (answer.probabilities !== undefined) {
    if (!answer.probabilities || typeof answer.probabilities !== "object")
      throw fail("bad_response", `answer ${id} has invalid probabilities`);
    for (const v of Object.values(answer.probabilities)) {
      if (finiteNumber(v) === null) throw fail("bad_response", `answer ${id} has invalid probabilities`);
    }
  }
  return {
    type: "score",
    score: Number(m[1]) - 1,
    ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
  };
}

function checkNoul(id: string, answer: Answer): { type: "boolean"; probability: number } {
  const p = finiteNumber(answer.noul);
  if (p === null || p < 0 || p > 1) throw fail("bad_response", `answer ${id} has invalid noul probability`);
  return { type: "boolean", probability: p };
}

function checkChoice(
  id: string,
  question: Question,
  answer: Answer,
): { type: "choice"; choice: string; probabilities?: Record<string, unknown> } {
  const options = question.criteria && typeof question.criteria === "object" ? Object.keys(question.criteria) : [];
  if (typeof answer.choice !== "string" || !options.includes(answer.choice)) {
    throw fail("bad_response", `answer ${id} selects an undeclared option`);
  }
  if (answer.probabilities !== undefined) {
    if (!answer.probabilities || typeof answer.probabilities !== "object")
      throw fail("bad_response", `answer ${id} has invalid probabilities`);
    for (const [k, v] of Object.entries(answer.probabilities)) {
      if (!options.includes(k) || finiteNumber(v) === null)
        throw fail("bad_response", `answer ${id} has invalid probabilities`);
    }
  }
  return {
    type: "choice",
    choice: answer.choice,
    ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
  };
}

function checkScore(
  id: string,
  question: Question,
  answer: Answer,
): { type: "score"; score: number; probabilities?: Record<string, unknown> } {
  const levels = Array.isArray(question.criteria) ? question.criteria.length : 0;
  const s = finiteNumber(answer.score);
  if (s === null || levels < 2 || s < 0 || s > levels - 1)
    throw fail("bad_response", `answer ${id} has out-of-range score`);
  if (answer.probabilities !== undefined) {
    if (!answer.probabilities || typeof answer.probabilities !== "object")
      throw fail("bad_response", `answer ${id} has invalid probabilities`);
    for (const v of Object.values(answer.probabilities)) {
      if (finiteNumber(v) === null) throw fail("bad_response", `answer ${id} has invalid probabilities`);
    }
  }
  return { type: "score", score: s, ...(answer.probabilities ? { probabilities: answer.probabilities } : {}) };
}

function toInternalAnswers(
  questions: Questions = {},
  answers: Record<string, Answer> | null | undefined,
): Record<string, unknown> {
  // Validate every declared question so missing provider fields fail closed instead of becoming partial decisions.
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    throw fail("bad_response", "response has no answers map");
  const out: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions || {})) {
    const answer = answers[id] as Answer;
    if (!answer || typeof answer !== "object") throw fail("bad_response", `missing answer for ${id}`);
    if (q.type === "boolean" && answer.type === "noul") out[id] = checkNoul(id, answer);
    else if (q.type === "choice" && answer.type === "choice") out[id] = checkChoice(id, q, answer);
    else if (q.type === "score" && answer.type === "choice") out[id] = checkRiskChoice(id, answer);
    else if (q.type === "score" && answer.type === "score") out[id] = checkScore(id, q, answer);
    else throw fail("bad_response", `answer ${id} type mismatch`);
  }
  return out;
}

function classifyHttpStatus(status: number, data: unknown): ClassifiedError {
  // Map provider statuses to stable error kinds so callers can choose retry or fallback behavior.
  const bodyText = JSON.stringify(data || {}).slice(0, 300);
  if (status === 401 || status === 403)
    return fail("auth", `experiential rejected credentials (http ${status})`, status);
  if (status === 402 || QUOTA_RES.test(bodyText))
    return fail("quota", `experiential free usage exhausted (${bodyText.slice(0, 120)})`, status);
  if (status === 429) return fail("rate_limit", `experiential rate limited (http 429)`, status);
  if (status === 422)
    return fail("bad_response", `experiential rejected request shape (http 422): ${bodyText.slice(0, 120)}`, status);
  if (status >= 500) return fail("unavailable", `experiential unavailable (http ${status})`, status);
  return fail("bad_response", `experiential unexpected status (http ${status})`, status);
}

async function defaultHttpPost(
  url: string,
  body: unknown,
  { headers, timeoutMs, apiKey }: { headers: Record<string, string>; timeoutMs: number; apiKey: string | null },
): Promise<HttpResponse> {
  // The adapter owns the single JSON POST, including its bearer header and timeout.
  if (!apiKey) throw fail("auth", "experiential api key missing");
  const res = await axios.post(url, body, {
    headers: { ...headers, Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    timeout: timeoutMs,
    maxRedirects: 0,
  });
  return { status: res.status, data: res.data };
}

async function experientialEvaluate(
  {
    baseUrl,
    apiKey,
    model,
    state,
    questions,
    timeoutMs = 8000,
  }: {
    baseUrl?: string;
    apiKey?: string | null;
    model?: string;
    state?: unknown;
    questions?: Questions;
    timeoutMs?: number;
  } = {},
  deps: AdapterDeps = {},
): Promise<{ model: string; answers: Record<string, unknown>; usage: Record<string, unknown> }> {
  if (!model) throw fail("bad_response", "experiential model missing");
  if (!isFreeModel(model))
    throw fail("config", "experiential free-lane only: refusing a model without a :free/-free suffix");
  const url = String(baseUrl || "").replace(/\/+$/, "") || "https://api.experientiallabs.ai/v1/systemone";
  const wireQuestions = toWireQuestions(questions || {});
  const httpPost = deps.httpPost || defaultHttpPost;
  let res;
  // A malformed response is an error result, never an exception loop in the caller.
  try {
    res = await httpPost(
      url,
      { model, state, questions: wireQuestions },
      { headers: {}, timeoutMs, apiKey: apiKey ?? null },
    );
  } catch (err) {
    const error = (err && typeof err === "object" ? err : {}) as Partial<ClassifiedError> & {
      response?: { status?: unknown; data?: unknown };
      code?: unknown;
    };
    if (error.jevErrorKind) throw err;
    const status = error.response?.status ?? error.status;
    if (typeof status === "number") throw classifyHttpStatus(status, error.response?.data);
    if (/timeout|timed out|abort|ECONNABORTED/i.test(String(error.message || error.code || ""))) {
      throw fail("timeout", `experiential request timed out after ${timeoutMs}ms`);
    }
    throw fail(
      "unavailable",
      `experiential unreachable (${String(error.code || error.message || "network").slice(0, 80)})`,
    );
  }
  if (!res || typeof res.status !== "number") throw fail("bad_response", "experiential transport returned no status");
  if (res.status < 200 || res.status >= 300) throw classifyHttpStatus(res.status, res.data);
  const body = res.data as { model?: string; answers?: Record<string, Answer>; usage?: unknown };
  if (!body || typeof body !== "object") throw fail("bad_response", "experiential returned no body");
  return {
    model: body.model || model,
    answers: toInternalAnswers(questions || {}, body.answers),
    usage: body.usage && typeof body.usage === "object" ? (body.usage as Record<string, unknown>) : {},
  };
}

export = {
  experientialEvaluate,
  toWireQuestions,
  toInternalAnswers,
  classifyHttpStatus,
  isFreeModel,
  RISK_CHOICE_CRITERIA,
};
