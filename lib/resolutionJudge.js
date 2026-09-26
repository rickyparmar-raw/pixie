const jev = require("./jevDecision");

const MAX_MESSAGES = 40;
const MAX_CHARS = 8000;
const LABELS = {
  resolved: "The issue is solved: the requester confirms success, accepts a helper's completed answer, or withdraws the request because they figured it out.",
  unresolved: "The issue is still active, broken, disputed, or the requester asks for more help without a clear resolution.",
  waiting: "The thread is waiting on a person, more information, or a next step; nobody has clearly established that the issue is solved.",
};

const QUESTIONS = {
  resolution: {
    type: "choice",
    instructions: "Classify only the outcome of the ticket conversation. Use resolved only when the supplied thread shows a credible resolution, not merely a proposed answer or silence.",
    criteria: LABELS,
  },
};

function clean(value, max = MAX_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function roleOf(message) {
  const role = String(message?.role || message?.speaker || "other").toLowerCase();
  if (["requester", "helper", "pixie", "other"].includes(role)) return role;
  if (role === "assistant" || role === "bot") return "pixie";
  return "other";
}

function boundedTranscript(transcript) {
  const rows = Array.isArray(transcript) ? transcript.slice(-MAX_MESSAGES) : [];
  const lines = [];
  let total = 0;
  for (const row of rows) {
    const text = clean(row?.text ?? row?.content, MAX_CHARS);
    if (!text) continue;
    const line = `[${roleOf(row)}] ${text}`;
    if (total + line.length > MAX_CHARS && lines.length > 0) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

function reasonFor(verdict) {
  return verdict === "resolved"
    ? "Jev found clear evidence that the issue was solved."
    : verdict === "unresolved"
      ? "Jev found evidence that the issue remains active."
      : "Jev found that the thread is still waiting or inconclusive.";
}

async function judgeResolution({ ticket, transcript } = {}, deps = {}) {
  const state = {
    task: "ticket_resolution",
    question: clean(ticket?.question, 2000),
    transcript: boundedTranscript(transcript),
    program: { id: ticket?.program_id || null, name: ticket?.program_name || null },
  };
  try {
    const outcome = await (deps.evaluateDecision || jev.evaluateCustomDecision)({ state, questions: QUESTIONS }, deps.jev || deps);
    if (!outcome || outcome.status !== "ok") return { verdict: "unknown" };
    const answer = outcome.result?.answers?.resolution;
    const verdict = answer?.choice;
    if (!Object.hasOwn(LABELS, verdict)) return { verdict: "unknown" };
    const confidence = typeof answer.probabilities?.[verdict] === "number"
      ? Math.min(1, Math.max(0, answer.probabilities[verdict]))
      : 0;
    return { verdict, confidence, reason: reasonFor(verdict) };
  } catch (_) {
    return { verdict: "unknown" };
  }
}

module.exports = { judgeResolution, boundedTranscript, QUESTIONS, MAX_MESSAGES, MAX_CHARS };
