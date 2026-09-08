// Helper copilot: AI assistance for humans working tickets. Every function is
// a pure read + optional model call that RETURNS text for a human to review.
// Nothing here posts to Slack, mutates tickets, or teaches the corpus —
// sending is always an explicit human action through tickets.replyToTicket.
//
// Grounding reuses the exact requester pipeline (lookup.answerOrChat), so a
// draft cites the same sources a direct answer would. Verdicts that must not
// depend on model self-confidence (fact check, similar tickets) are computed
// deterministically from retrieval scores and stored state instead.
const lookup = require("./lookup");
const retrieve = require("./retrieve");
const knowledge = require("./knowledge");
const context = require("./context");
const db = require("./db");
const log = require("./log");
const audit = require("./audit");
const rateLimit = require("./rateLimit");
const { config } = require("./config");
const respond = require("./respond");

// One burst of drafts per minute per helper: generous for real triage,
// tight enough that a stuck retry loop cannot burn the model budget.
const COPILOT_WINDOW_MS = 60 * 1000;
const COPILOT_MAX_PER_WINDOW = 20;
// Grounded drafts read as confident, ungrounded ones as flagged — the helper
// decides in both cases, so the numbers only rank, never certify.
const GROUNDED_CONFIDENCE = 0.8;
const UNGROUNDED_CONFIDENCE = 0.2;
// Numbers, dates, URLs, channel refs, quoted literals: the tokens an edit
// must not silently gain or lose.
const FACTUAL_TOKEN_RE = /\b\d[\d.,]*\b|https?:\/\/\S+|<#[A-Z0-9]+(?:\|[^>]+)?>|#[a-z0-9_-]+|"[^"]+"/gi;
// Only the tail matters for a handoff; older turns repeat the same attempts.
const SUMMARY_TAIL = 12;
const SUMMARY_LINE_CHARS = 300;
const SUMMARY_PROMPT_CHARS = 3000;
const SUMMARY_POLISH_TOKENS = 300;
// Only opposing cues on the same claim shape count as contradiction —
// anything subtler stays unsupported, never a confident accusation.
const OPPOSITION = [
  [/\bcan\b/i, /\b(can't|cannot|not allowed|isn't allowed)\b/i],
  [/\bsupported\b/i, /\b(not supported|unsupported)\b/i],
  [/\bmust\b/i, /\b(must not|mustn't|never)\b/i],
];
// Similar-ticket search stays bounded: 200 recent resolutions in, 10 out.
const SIMILAR_SCAN_LIMIT = 200;
const SIMILAR_RETURN_MAX = 10;

function checkBudget(actorId) {
  const res = rateLimit.check(`copilot:${actorId}`, { windowMs: COPILOT_WINDOW_MS, max: COPILOT_MAX_PER_WINDOW });
  if (res.allowed) return null;
  return { error: "copilot rate limited — try again in a minute" };
}

function auditCopilot(programId, actorId, action, metadata = null) {
  audit.record({ programId, actorId, action: `copilot.${action}`, entityType: "copilot", entityId: null, metadata });
}

// Groundedness uses the same predicate as requester answers: a draft that is
// not grounded is still returned (the helper decides), but flagged.
function draftVerdict(result) {
  const grounded = respond.isGroundedAnswer(result);
  return {
    draft: result && result.answer ? result.answer : null,
    source: (result && result.source) || null,
    sourceUrl: result && result.source ? knowledge.getSourceUrl(result.source) : null,
    grounded,
    confidence: grounded ? GROUNDED_CONFIDENCE : UNGROUNDED_CONFIDENCE,
    verification: grounded ? "grounded in cited source" : "not grounded — review against docs before sending",
  };
}

function threadContextFor(threadTs) {
  if (!threadTs) return "";
  try {
    if (!context.getThreadContext) return "";
    return context.getThreadContext(threadTs) || "";
  } catch (e) {
    log.warn("copilot", `failed to get thread context for ${threadTs}: ${e.message}`);
    return "";
  }
}

async function draftReply({ program, question, threadTs = null }) {
  const programId = program ? program.id : null;
  // Same pipeline, same corpus, same program scope as a requester answer —
  // including its silence rules. A null result means "no grounded answer",
  // which is itself the signal to escalate rather than improvise.
  const result = await lookup.answerOrChat(question, threadContextFor(threadTs), { program });
  return { ...draftVerdict(result), programId };
}

async function ask({ program, question, threadTs = null }) {
  const result = await lookup.answerOrChat(question, threadContextFor(threadTs), { program });
  return { ...draftVerdict(result), programId: program ? program.id : null };
}

async function completeHelper(prompt, maxTokens = 600) {
  const llm = require("./llm");
  const tier = config.answer;
  const res = await llm.complete(
    {
      apiKey: tier.apiKey,
      baseUrl: tier.baseUrl,
      model: tier.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      temperature: 0.2,
      ...(tier.fallback ? { fallback: tier.fallback } : {}),
      ...(tier.onRateLimited ? { onRateLimited: tier.onRateLimited } : {}),
    },
    "copilot",
  );
  if (!res || !res.text) return "";
  return res.text.trim();
}

function factualTokens(text) {
  const found = new Set();
  for (const m of String(text || "").matchAll(FACTUAL_TOKEN_RE)) found.add(m[0]);
  return found;
}

function tokenNotes(before, after) {
  const notes = [];
  for (const tok of after) {
    if (!before.has(tok)) notes.push(`added factual token: ${tok}`);
  }
  for (const tok of before) {
    if (!after.has(tok)) notes.push(`dropped factual token: ${tok}`);
  }
  return notes;
}

async function improveReply({ text }) {
  const clean = String(text || "").trim();
  if (!clean) return { error: "reply text required" };
  const before = factualTokens(clean);
  let improved = "";
  try {
    improved = await completeHelper(
      `Rewrite this support reply for clarity, tone, and conciseness. Do NOT add facts, dates, numbers, or links that are not already present. Keep it short.\n\n${clean}`,
    );
  } catch (e) {
    log.warn("copilot", `improve failed: ${e.message}`);
    return { improved: clean, notes: ["AI unavailable — returning the original text unchanged"], changed: false };
  }
  if (!improved) return { improved: clean, notes: ["AI returned nothing — original kept"], changed: false };
  return { improved, notes: tokenNotes(before, factualTokens(improved)), changed: improved !== clean };
}

function loadTranscript(messages, threadTs) {
  if (Array.isArray(messages) && messages.length > 0) return messages;
  if (!threadTs) return [];
  try {
    return db.getThreadMessages(threadTs) || [];
  } catch (e) {
    log.warn("copilot", `failed to load transcript for thread ${threadTs}: ${e.message}`);
    return [];
  }
}

function formatTranscriptLine(m) {
  const who = m.role === "assistant" ? "pixie" : m.user_id || m.role || "user";
  return `${who}: ${(m.content || "").slice(0, SUMMARY_LINE_CHARS)}`;
}

function extractiveSummary(ticket, transcript, timeline) {
  const parts = [];
  if (ticket) {
    parts.push(`Question: ${ticket.question}`);
    if (ticket.summary) parts.push(`Triage: ${ticket.summary}`);
    parts.push(`Status: ${ticket.status}${ticket.assignee_id ? ` (assignee <@${ticket.assignee_id}>)` : ""}`);
  }
  const lines = transcript.slice(-SUMMARY_TAIL).map(formatTranscriptLine);
  if (lines.length > 0) parts.push(`Recent thread:\n${lines.join("\n")}`);
  if (timeline.length > 0) {
    parts.push(`Events: ${timeline.map((e) => `${e.event_type}${e.actor_id ? ` by <@${e.actor_id}>` : ""}`).join(", ")}`);
  }
  return parts.join("\n\n") || "No thread context available.";
}

async function summarizeThread({ program, ticket = null, threadTs = null, messages = null }) {
  const transcript = loadTranscript(messages, threadTs);
  const timeline = ticket ? db.listTicketEvents(ticket.id, 50) : [];
  const extractive = extractiveSummary(ticket, transcript, timeline);
  let polished = null;
  try {
    polished = await completeHelper(
      `Condense this support-thread state into 3 short bullets: what the user needs, what has been tried, what remains unresolved. No greeting, no new facts.\n\n${extractive.slice(0, SUMMARY_PROMPT_CHARS)}`,
      SUMMARY_POLISH_TOKENS,
    );
  } catch (e) {
    log.debug("copilot", `summarize polish failed: ${e.message}`);
  }
  return { summary: polished || extractive, aiPolished: !!polished, programId: program ? program.id : null };
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function evidenceFor(ranked) {
  return ranked.slice(0, 2).map((r) => ({
    source: r.chunk.source,
    heading: r.chunk.heading || null,
    excerpt: r.chunk.text.slice(0, 200),
    score: Number(r.value.toFixed(3)),
  }));
}

function findContradiction(sentence, excerpt) {
  for (const [pos, neg] of OPPOSITION) {
    if ((pos.test(sentence) && neg.test(excerpt)) || (neg.test(sentence) && pos.test(excerpt))) return true;
  }
  return false;
}

function checkSentence(index, sentence) {
  const terms = retrieve.tokenize(sentence);
  if (terms.length === 0) return null;
  const ranked = retrieve.score(index, terms).slice(0, 3);
  const top = ranked[0];
  if (!top) return { sentence, verdict: "unsupported", evidence: [] };
  const evidence = evidenceFor(ranked);
  // Narrow contradiction signal only: the sentence and its best evidence
  // carrying opposing cues on the same claim shape. Anything subtler is
  // "unsupported", never a confident contradiction.
  if (!findContradiction(sentence, evidence[0].excerpt)) {
    return { sentence, verdict: "supported", evidence };
  }
  return { sentence, verdict: "contradiction", evidence, contradiction: { against: evidence[0] } };
}

async function factCheck({ program, text }) {
  const programId = program ? program.id : null;
  let index = null;
  try {
    index = knowledge.getIndex(programId);
  } catch (e) {
    return { error: `no retrieval index for program: ${e.message}` };
  }
  const verdicts = [];
  for (const sentence of splitSentences(text)) {
    const verdict = checkSentence(index, sentence);
    if (verdict) verdicts.push(verdict);
  }
  const counts = verdicts.reduce((acc, v) => {
    acc[v.verdict] = (acc[v.verdict] || 0) + 1;
    return acc;
  }, {});
  return { verdicts, counts, programId };
}

function clampLimit(limit) {
  return Math.min(Math.max(limit, 1), SIMILAR_RETURN_MAX);
}

function findSimilar({ programId, question, limit = 5 }) {
  if (!programId || !question) return { error: "programId and question required" };
  let resolved = [];
  try {
    resolved = db.handle().query(`SELECT * FROM tickets WHERE program_id = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT ${SIMILAR_SCAN_LIMIT}`).all(programId);
  } catch (e) {
    return { error: e.message };
  }
  const overlap = require("./gapClusters").pairOverlap;
  const ranked = resolved
    .map((t) => ({
      ticketId: t.id,
      question: t.question,
      summary: t.summary,
      resolution: t.resolution,
      category: t.category,
      resolvedAt: t.resolved_at,
      similarity: Number(overlap(question, `${t.question} ${t.summary || ""}`).toFixed(3)),
    }))
    .filter((c) => c.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, clampLimit(limit));
  return { candidates: ranked, programId };
}

module.exports = {
  checkBudget,
  draftReply,
  improveReply,
  summarizeThread,
  factCheck,
  findSimilar,
  ask,
  auditCopilot,
  factualTokens,
};
