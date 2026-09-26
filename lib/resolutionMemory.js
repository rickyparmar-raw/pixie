// Verified resolution memory: resolved tickets become knowledge only after
// human review. A candidate is proposed (LLM-extracted, validated, or
// human-written), an authorized helper approves/edits/rejects it, and only
// approved rows enter the corpus through the existing learned_facts path —
// the same invalidateCorpus() that teaching uses, so caches stay coherent.
const db = require("./db");
const log = require("./log");
const audit = require("./audit");
const learn = require("./learn");
const { config } = require("./config");

const CANDIDATE = "candidate";
const REJECTED = "rejected";

function existingCandidate(ticketId) {
  try {
    return db.candidateForTicket(ticketId);
  } catch (e) {
    log.warn("resolution-memory", `failed to fetch existing candidate for ticket ${ticketId}: ${e.message}`);
    return null;
  }
}

function validateExtraction(obj) {
  if (!obj || typeof obj !== "object") return null;
  const problem = String(obj.problem || "").trim();
  const solution = String(obj.solution || "").trim();
  if (!problem || !solution) return null;
  if (problem.length > 500 || solution.length > 2000) return null;
  const category = String(obj.category || "").trim().slice(0, 60) || null;
  const cause = String(obj.cause || "").trim().slice(0, 500) || null;
  return { problem, solution, category, cause };
}

async function extractCandidate(ticket, events) {
  const llm = require("./llm");
  const threadBits = [];
  try {
    const msgs = db.getThreadMessages(ticket.thread_ts) || [];
    for (const m of msgs.slice(-10)) threadBits.push(`${m.role}: ${(m.content || "").slice(0, 400)}`);
  } catch (e) {
    log.warn("resolution-memory", `failed to get thread messages for ticket ${ticket.thread_ts}: ${e.message}`);
  }
  const prompt = [
    "Extract a reusable support fact from this resolved ticket as JSON:",
    '{"problem": "<one-line user problem>", "cause": "<root cause or empty>", "solution": "<verified fix>", "category": "<short category>"}',
    "Reply with JSON only. If no reusable fact exists, reply {}.",
    "",
    `Question: ${ticket.question}`,
    `Resolution: ${ticket.resolution || ""}`,
    ...(threadBits.length > 0 ? ["", "Thread:", ...threadBits] : []),
  ].join("\n");
  const res = await llm.complete(
    {
      apiKey: config.intent.apiKey,
      baseUrl: config.intent.baseUrl,
      model: config.intent.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 400,
      temperature: 0,
      ...(config.intent.fallback ? { fallback: config.intent.fallback } : {}),
    },
    "resolution-memory",
  );
  const text = (res && res.text ? res.text : "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return validateExtraction(JSON.parse(match[0]));
  } catch (e) {
    log.debug("resolution-memory", `failed to parse candidate JSON: ${e.message}`);
    return null;
  }
}

async function proposeFromTicket({ ticketId, actorId }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.status !== "resolved") return { error: "only resolved tickets yield candidates" };
  const dupe = existingCandidate(ticketId);
  if (dupe) return { ok: true, candidate: dupe, duplicate: true };

  let extraction = null;
  try {
    extraction = await extractCandidate(ticket, db.listTicketEvents(ticketId, 50));
  } catch (e) {
    log.warn("resolution-memory", `extraction failed for #${ticketId}: ${e.message}`);
  }
  const question = extraction ? extraction.problem : ticket.question;
  const answer = extraction
    ? [extraction.solution, extraction.cause ? `Cause: ${extraction.cause}` : null].filter(Boolean).join("\n")
    : (ticket.resolution || ticket.summary || ticket.question);
  const id = db.addLearnedFact({
    question,
    answer,
    authorId: actorId || null,
    status: CANDIDATE,
    channel: ticket.channel,
    programId: ticket.program_id,
    category: (extraction && extraction.category) || ticket.category || null,
    ticketId: ticket.id,
    resolverId: ticket.assignee_id || actorId || null,
  });
  if (!id) return { error: "could not store candidate" };
  const candidate = db.getLearnedFactById(id);
  audit.record({ programId: ticket.program_id, actorId, action: "knowledge.candidate_proposed", entityType: "learned_fact", entityId: id, metadata: { ticketId } });
  return { ok: true, candidate, aiExtracted: !!extraction };
}

function approveCandidate({ id, actorId, edits = {} }) {
  const row = db.getLearnedFactById(id);
  if (!row) return { error: "candidate not found" };
  if (row.status !== CANDIDATE && row.status !== "pending") return { error: "only candidates can be approved here" };
  if (edits.question || edits.answer || edits.category) {
    db.updateLearnedFact(id, { question: edits.question || null, answer: edits.answer || null, category: edits.category || null });
  }
  // learn.approve() stamps verified_at and invalidates caches + corpus.
  if (!learn.approve(id)) return { error: "approval failed" };
  audit.record({ programId: row.program_id, actorId, action: "knowledge.candidate_approved", entityType: "learned_fact", entityId: id, metadata: { ticketId: row.ticket_id } });
  return { ok: true, fact: db.getLearnedFactById(id) };
}

function rejectCandidate({ id, actorId }) {
  const row = db.getLearnedFactById(id);
  if (!row) return { error: "candidate not found" };
  if (row.status !== CANDIDATE && row.status !== "pending" && !(row.status === "approved" && row.auto_learned)) {
    return { error: "only candidates can be rejected here" };
  }
  if (!db.setLearnedStatus(id, REJECTED)) return { error: "rejection failed" };
  require("./learn").invalidateCorpus();
  audit.record({ programId: row.program_id, actorId, action: "knowledge.candidate_rejected", entityType: "learned_fact", entityId: id, metadata: { ticketId: row.ticket_id } });
  return { ok: true };
}

function listCandidates(programId, status = CANDIDATE, limit = 50) {
  if (status === CANDIDATE) return db.listReviewableLearnedFacts(programId, limit);
  return db.listLearnedFacts(status, limit, programId);
}

module.exports = {
  proposeFromTicket,
  approveCandidate,
  rejectCandidate,
  listCandidates,
  validateExtraction,
  extractCandidate,
  CANDIDATE,
  REJECTED,
};
