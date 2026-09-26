const audit = require("./audit");
const db = require("./db");
const log = require("./log");
const programs = require("./programs");
const retrieve = require("./retrieve");
const resolutionMemory = require("./resolutionMemory");
const learn = require("./learn");

const SIMILARITY_THRESHOLD = 0.6;
const CLOSED = new Set(["resolved", "closed"]);
const EXCLUDED = new Set(["duplicate", "spam"]);

function normalizeAnswer(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function similarity(left, right) {
  const a = new Set(retrieve.tokenize(left));
  const b = new Set(retrieve.tokenize(right));
  if (a.size === 0 || b.size === 0) return normalizeAnswer(left) === normalizeAnswer(right) ? 1 : 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / (a.size + b.size - common);
}

function helperAnswered(ticket) {
  const events = db.listTicketEvents(ticket.id, 100);
  if (events.some((event) => event.event_type === "helper_reply")) return true;
  const requester = ticket.requester_id;
  return [ticket.assignee_id, ticket.resolved_by].some((id) => id && id !== requester);
}

function excludedTicket(ticket) {
  if (!ticket || EXCLUDED.has(ticket.status) || ticket.duplicate_of) return true;
  return db.listTicketEvents(ticket.id, 100).some((event) => EXCLUDED.has(event.event_type));
}

function answerFromExtraction(extraction, ticket) {
  if (!extraction) return null;
  const answer = [extraction.solution, extraction.cause ? `Cause: ${extraction.cause}` : null].filter(Boolean).join("\n").trim();
  if (!answer) return null;
  return {
    question: extraction.problem,
    answer,
    category: extraction.category || ticket.category || null,
  };
}

async function extractFact(ticket) {
  let extraction = null;
  try {
    extraction = await resolutionMemory.extractCandidate(ticket, db.listTicketEvents(ticket.id, 50));
  } catch (error) {
    log.warn("active-learning", `extraction failed for #${ticket.id}: ${error.message}`);
  }
  return answerFromExtraction(extraction, ticket) || {
    question: ticket.question,
    answer: String(ticket.resolution || "").trim(),
    category: ticket.category || null,
  };
}

async function learnFromResolution({ ticket, workerId = null }) {
  if (!ticket || !CLOSED.has(ticket.status) || excludedTicket(ticket) || !helperAnswered(ticket)) {
    return { ok: false, skipped: true };
  }
  if (!String(ticket.resolution || "").trim()) return { ok: false, skipped: true };

  const existingForTicket = db.learnedFactForTicket(ticket.id);
  if (existingForTicket && existingForTicket.status !== "superseded") {
    return { ok: true, fact: existingForTicket, duplicate: true };
  }

  const fact = await extractFact(ticket);
  if (!fact.question || !fact.answer) return { ok: false, skipped: true };
  const program = ticket.program || programs.get(ticket.program_id);
  const mode = program?.learning === "review" ? "review" : "auto";
  const status = mode === "review" ? "candidate" : "approved";
  const overlaps = fact.category
    ? db.learnedFactsForOverlap(ticket.program_id, fact.category)
      .filter((row) => similarity(row.question, fact.question) >= SIMILARITY_THRESHOLD)
    : [];
  const same = overlaps.find((row) => normalizeAnswer(row.answer) === normalizeAnswer(fact.answer));
  if (same) {
    db.refreshLearnedFact(same.id);
    learn.invalidateCorpus();
    return { ok: true, fact: db.getLearnedFactById(same.id), refreshed: true };
  }

  // The helper whose reply carried the ticket (see tickets.resolveTicketWorker).
  const helperId = workerId || ticket.assignee_id || ticket.resolved_by || null;
  const id = db.addLearnedFact({
    question: fact.question,
    answer: fact.answer,
    authorId: helperId,
    status,
    sourceTs: `resolution:${ticket.id}`,
    channel: ticket.channel,
    programId: ticket.program_id,
    category: fact.category,
    ticketId: ticket.id,
    resolverId: helperId,
    autoLearned: mode === "auto",
  });
  if (!id) {
    const duplicate = db.learnedFactForTicket(ticket.id);
    return duplicate ? { ok: true, fact: duplicate, duplicate: true } : { ok: false, error: "could not store fact" };
  }
  for (const old of overlaps) db.supersedeLearnedFact(old.id, id);
  if (status === "approved") learn.invalidateCorpus();
  const stored = db.getLearnedFactById(id);
  audit.record({
    programId: ticket.program_id,
    actorId: helperId,
    action: mode === "auto" ? "knowledge.auto_learned" : "knowledge.candidate_proposed",
    entityType: "learned_fact",
    entityId: id,
    metadata: { ticketId: ticket.id, resolverId: helperId, autoLearned: mode === "auto" },
  });
  return { ok: true, fact: stored, autoLearned: mode === "auto", superseded: overlaps.map((row) => row.id) };
}

module.exports = {
  learnFromResolution,
  similarity,
  SIMILARITY_THRESHOLD,
};
