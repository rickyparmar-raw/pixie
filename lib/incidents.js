// Duplicate suggestions and incident detection, both deterministic.
//
// Duplicates rank same-program open/recent tickets by wording overlap; a
// helper confirms, and confirmation writes the canonical relation plus audit.
// Nothing auto-merges.
//
// Incidents cluster recent open tickets by wording (reusing gap clustering).
// A cluster at/above threshold becomes one candidate; later tickets in the
// same cluster link to the existing candidate inside its cooldown instead of
// spawning fifty incidents for one outage. Announcements are drafts only.
const db = require("./db");
const audit = require("./audit");
const gapClusters = require("./gapClusters");
const programs = require("./programs");
const slackMessages = require("./slackMessages");
const retrieve = require("./retrieve");

// WHY: one shared "same report" line so duplicates, bursts, and live matching
// agree — three thresholds would let a pair count as duplicate but not incident.
const SIMILARITY_THRESHOLD = 0.35;
// WHY: duplicates triage recent work, not archaeology — a month bounds the
// scan to tickets a helper could still act on.
const DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// WHY: an outage is a tight spike in time — one hour catches it without
// sweeping the whole day's unrelated questions into one candidate.
const INCIDENT_WINDOW_MS = 60 * 60 * 1000;
// WHY: four similar tickets in an hour is the smallest spike worth a human
// look; fewer is routine coincidence.
const INCIDENT_THRESHOLD = 4;
// WHY: one outage must stay one incident — later tickets in the same burst
// link to the live candidate instead of opening a second row for the same shape.
const INCIDENT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// Pure wording score, no I/O — the single definition of "similar enough".
function similarityScore(a, b) {
  return gapClusters.pairOverlap(a, b);
}

// WHY: threshold lives in one place so the three call sites cannot drift apart.
function isSimilar(a, b, threshold = SIMILARITY_THRESHOLD) {
  return similarityScore(a, b) >= threshold;
}

// WHY: unbounded limits let one question dump the whole table into a response.
function clampLimit(limit) {
  return Math.min(Math.max(limit, 1), 10);
}

// WHY: rounding is part of the contract — callers display this number, so it
// must equal the scored value rather than a longer float.
function scoreDuplicate(question, row) {
  return Number(similarityScore(question, row.question).toFixed(3));
}

function rankDuplicateCandidates(question, rows, ticketId, limit) {
  return rows
    .filter((t) => t.id !== ticketId)
    .map((t) => ({
      ticketId: t.id,
      question: t.question,
      summary: t.summary,
      status: t.status,
      createdAt: t.created_at,
      similarity: scoreDuplicate(question, t),
    }))
    .filter((c) => c.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, clampLimit(limit));
}

// Pure best-match over already-fetched confirmed incidents — DB stays in the caller.
function pickBestIncident(question, active) {
  let best = null;
  let bestScore = 0;
  for (const inc of active) {
    const score = incidentSimilarity(question, inc);
    if (score > bestScore) {
      bestScore = score;
      best = inc;
    }
  }
  if (!best || bestScore < SIMILARITY_THRESHOLD) return null;
  return best;
}

function incidentTerms(text) {
  const raw = String(text || "").toLowerCase();
  const terms = new Set(retrieve.tokenize(raw));
  if (/\b(?:site|website|webpage|page|load|open|access|reach|working)\b/.test(raw)) terms.add("incident_access");
  if (/\b(?:down|offline|unavailable|broken|inaccessible|failing|failed|failure|problem|issue|error|cant|cannot|unable|wont)\b/.test(raw)
    || /\b(?:can't|won't|not)\s+(?:load|open|access|reach|work)\b/.test(raw)) {
    terms.add("incident_outage");
  }
  return terms;
}

function incidentSimilarity(question, incident) {
  const texts = [incident.title, incident.description].filter(Boolean);
  const questionTerms = incidentTerms(question);
  let score = 0;
  for (const text of texts) {
    score = Math.max(score, similarityScore(question, text));
    const incidentTermsForText = incidentTerms(text);
    if (questionTerms.has("incident_access") && questionTerms.has("incident_outage")
      && incidentTermsForText.has("incident_access") && incidentTermsForText.has("incident_outage")) score = Math.max(score, 0.5);
  }
  return score;
}

// WHY: confidence grows with corroboration but never claims certainty from wording alone.
function burstConfidence(count) {
  return Math.min(0.5 + count * 0.05, 0.95);
}

function burstReason(count, windowMs) {
  return `${count} similar tickets in ${Math.round(windowMs / 60000)}m`;
}

function truncateTitle(s) {
  return String(s).slice(0, 200);
}

function defaultResolutionText(title) {
  return `Update: the issue reported earlier ("${title}") has been resolved. Please try again — if you're still stuck, reply here.`;
}

function fetchDuplicateRows(programId, cutoff) {
  return db.handle().query(
    `SELECT id, question, summary, status, created_at FROM tickets
     WHERE program_id = ? AND created_at > ? AND status IN ('open','waiting_for_helper','assigned','claimed','escalated','reopened','resolved')
     ORDER BY created_at DESC LIMIT 200`,
  ).all(programId, cutoff);
}

function fetchRecentTickets(programId, cutoff) {
  return db.handle().query(
    `SELECT id, question, thread_ts, created_at FROM tickets
     WHERE program_id = ? AND created_at > ? AND status NOT IN ('closed','spam','duplicate')
     ORDER BY created_at ASC LIMIT 300`,
  ).all(programId, cutoff);
}

function fetchLiveIncidents(programId, now) {
  return db.handle().query(
    "SELECT * FROM program_incidents WHERE program_id = ? AND status IN ('candidate','confirmed') AND created_at > ? ORDER BY created_at DESC LIMIT 10",
  ).all(programId, now - INCIDENT_COOLDOWN_MS);
}

function findCooldownIncident(live, representative) {
  return live.find((inc) => isSimilar(inc.title, representative));
}

// WHY: position-keyed so identical questions from different tickets never
// collapse onto the first row sharing that text.
function buildQuestionIndex(rows) {
  const index = new Map();
  rows.forEach((r, i) => {
    if (!index.has(r.question)) index.set(r.question, []);
    index.get(r.question).push(i);
  });
  return index;
}

function resolveBurstMembers(rows, members, questionIndex, used) {
  const memberRows = [];
  for (const q of members) {
    const idx = (questionIndex.get(q) || []).find((i) => !used.has(i));
    if (idx === undefined) continue;
    used.add(idx);
    memberRows.push(rows[idx]);
  }
  return memberRows;
}

function linkRowsToIncident(incidentId, memberRows, programId, now) {
  let linked = 0;
  for (const r of memberRows) {
    const res = db.handle().query("INSERT OR IGNORE INTO incident_tickets (incident_id, ticket_id, program_id, linked_at) VALUES (?, ?, ?, ?)")
      .run(incidentId, r.id, programId, now);
    linked += res.changes;
  }
  return linked;
}

function insertCandidate({ programId, representative, memberRows, windowMs, startedAt, now }) {
  const title = truncateTitle(representative);
  const res = db.handle().query(
    `INSERT INTO program_incidents (program_id, title, status, reason, confidence, started_at, created_at)
     VALUES (?, ?, 'candidate', ?, ?, ?, ?)`,
  ).run(programId, title, burstReason(memberRows.length, windowMs), burstConfidence(memberRows.length), startedAt, now);
  return { incidentId: Number(res.lastInsertRowid), title };
}

function suggestDuplicates({ programId, ticketId = null, question, limit = 5 }) {
  if (!programId || !question) return { error: "programId and question required" };
  const rows = fetchDuplicateRows(programId, Date.now() - DUPLICATE_WINDOW_MS);
  return { candidates: rankDuplicateCandidates(question, rows, ticketId, limit) };
}

function getIncident(id) {
  return db.handle().query("SELECT * FROM program_incidents WHERE id = ?").get(id) || null;
}

function listIncidents(programId, status = null, limit = 50) {
  if (status) {
    return db.handle().query("SELECT * FROM program_incidents WHERE program_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(programId, status, limit);
  }
  return db.handle().query("SELECT * FROM program_incidents WHERE program_id = ? ORDER BY created_at DESC LIMIT ?").all(programId, limit);
}

function incidentTickets(incidentId) {
  return db.handle().query(
    `SELECT t.* FROM tickets t JOIN incident_tickets it ON it.ticket_id = t.id WHERE it.incident_id = ? ORDER BY t.created_at ASC`,
  ).all(incidentId);
}

function detectBursts({ programId, windowMs = INCIDENT_WINDOW_MS, threshold = INCIDENT_THRESHOLD } = {}) {
  if (!programId) return { error: "programId required" };
  const now = Date.now();
  const rows = fetchRecentTickets(programId, now - windowMs);
  if (rows.length < threshold) return { candidates: [] };

  const groups = gapClusters.clusterQuestions(rows.map((r) => r.question));
  const questionIndex = buildQuestionIndex(rows);
  const used = new Set();
  const out = [];
  for (const members of groups) {
    if (members.length < threshold) continue;
    const memberRows = resolveBurstMembers(rows, members, questionIndex, used);
    if (memberRows.length < threshold) continue;
    const startedAt = Math.min(...memberRows.map((r) => r.created_at));
    const representative = memberRows.sort((a, b) => a.created_at - b.created_at)[0].question;
    // Cooldown: link into a live candidate with the same shape instead of
    // opening a second incident for the same burst.
    const same = findCooldownIncident(fetchLiveIncidents(programId, now), representative);
    if (same) {
      const linked = linkRowsToIncident(same.id, memberRows, programId, now);
      out.push({ incidentId: same.id, title: same.title, status: same.status, linked, deduped: true });
      continue;
    }
    const { incidentId, title } = insertCandidate({ programId, representative, memberRows, windowMs, startedAt, now });
    linkRowsToIncident(incidentId, memberRows, programId, now);
    out.push({ incidentId, title, status: "candidate", linked: memberRows.length, deduped: false });
  }
  return { candidates: out };
}

// Declare turns a candidate into the authoritative ACTIVE incident: the
// description and public_message become what Pixie tells matching askers
// (see matchActiveIncident / lib/tickets.js escalateTicket) instead of a
// generic acknowledgement. Reuses the existing confirmed/resolved/dismissed
// status machine — DECLARED and ACTIVE are the same state here, entered in
// one step, since there is no useful organizer action between them.
function declareIncident({ incidentId, actorId = null, description = null, publicMessage = null }) {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  const t = Date.now();
  db.handle()
    .query("UPDATE program_incidents SET status = 'confirmed', confirmed_at = ?, description = ?, declared_by = ?, public_message = ? WHERE id = ?")
    .run(t, description || null, actorId, publicMessage || null, incidentId);
  audit.record({ programId: inc.program_id, actorId, action: "incident.declared", entityType: "incident", entityId: incidentId, metadata: { description, publicMessage } });
  return { ok: true, incident: getIncident(incidentId) };
}

function createIncident({ programId, title, description = null, publicMessage = null, actorId = null }) {
  if (!programId) return { error: "programId required" };
  if (!programs.get(programId)) return { error: "unknown program" };
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return { error: "title required" };
  const cleanDescription = description ? String(description).trim() : null;
  const cleanPublicMessage = publicMessage ? String(publicMessage).trim() : null;
  const now = Date.now();
  const result = db.handle().query(
    `INSERT INTO program_incidents
      (program_id, title, status, started_at, created_at, confirmed_at, description, declared_by, public_message)
     VALUES (?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`,
  ).run(programId, truncateTitle(cleanTitle), now, now, now, cleanDescription || null, actorId, cleanPublicMessage || null);
  const incidentId = Number(result.lastInsertRowid);
  audit.record({
    programId,
    actorId,
    action: "incident.declared",
    entityType: "incident",
    entityId: incidentId,
    metadata: { source: "manual", description: cleanDescription, publicMessage: cleanPublicMessage },
  });
  return { ok: true, incident: getIncident(incidentId) };
}

// The single match point for incident-aware answering: an ACTIVE (status =
// confirmed) incident whose title overlaps the asker's question closely
// enough that this is very likely the same report, not a coincidence.
// Reuses the same similarity threshold as burst detection and duplicate
// suggestion so "similar enough to be one incident" means one thing everywhere.
function matchActiveIncident({ programId, question }) {
  if (!programId || !question) return null;
  const active = listIncidents(programId, "confirmed", 20);
  if (active.length === 0) return null;
  return pickBestIncident(question, active);
}

// One row per distinct thread that got the incident answer instead of a
// ticket — the count "notify affected users" later shows, and the list it
// idempotently walks through.
function recordAffectedReport({ incidentId, programId, ticketId = null, requesterId, channel, threadTs }) {
  const already = db.handle().query("SELECT 1 FROM incident_reports WHERE incident_id = ? AND channel = ? AND thread_ts = ?").get(incidentId, channel, threadTs);
  if (already) return { ok: true, deduped: true };
  db.handle()
    .query("INSERT INTO incident_reports (incident_id, program_id, ticket_id, requester_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(incidentId, programId, ticketId, requesterId || null, channel, threadTs, Date.now());
  return { ok: true, deduped: false };
}

function affectedReports(incidentId, onlyUnnotified = false) {
  const clause = onlyUnnotified ? "AND notified_at IS NULL" : "";
  return db.handle().query(`SELECT * FROM incident_reports WHERE incident_id = ? ${clause} ORDER BY created_at ASC`).all(incidentId);
}

// Idempotent, retry-safe: only reports without notified_at are messaged, and
// each success is marked before moving to the next, so a re-run after a
// partial failure only reaches the ones still pending. Requires a real Slack
// client — this never fires automatically, only from an explicit organizer action.
async function notifyAffectedUsers({ incidentId, actorId = null, client, resolutionMessage = null }) {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  if (!client) return { error: "slack client unavailable" };
  const prog = programs.get(inc.program_id);
  const pending = affectedReports(incidentId, true);
  const text = resolutionMessage || defaultResolutionText(inc.title);
  let notified = 0;
  const errors = [];
  for (const r of pending) {
    try {
      await slackMessages.sendProgramMessage({ client, program: prog, channel: r.channel, threadTs: r.thread_ts, text });
      db.handle().query("UPDATE incident_reports SET notified_at = ? WHERE id = ?").run(Date.now(), r.id);
      notified += 1;
    } catch (e) {
      errors.push({ reportId: r.id, error: e.message });
    }
  }
  audit.record({ programId: inc.program_id, actorId, action: "incident.notified_affected", entityType: "incident", entityId: incidentId, metadata: { notified, failed: errors.length } });
  return { ok: true, notified, failed: errors.length, errors };
}

function setIncidentStatus({ incidentId, status, actorId = null }) {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  if (!["candidate", "confirmed", "dismissed", "resolved"].includes(status)) return { error: "invalid status" };
  const t = Date.now();
  const extra = status === "confirmed" ? ", confirmed_at = ?" : status === "resolved" ? ", resolved_at = ?" : "";
  const params = status === "candidate" || status === "dismissed" ? [status, incidentId] : [status, t, incidentId];
  db.handle().query(`UPDATE program_incidents SET status = ?${extra} WHERE id = ?`).run(...params);
  audit.record({ programId: inc.program_id, actorId, action: `incident.${status}`, entityType: "incident", entityId: incidentId });
  return { ok: true, incident: getIncident(incidentId) };
}

function linkTicket({ incidentId, ticketId, actorId = null }) {
  const inc = getIncident(incidentId);
  const ticket = db.getTicket(ticketId);
  if (!inc || !ticket) return { error: "incident or ticket not found" };
  if (inc.program_id !== ticket.program_id) return { error: "program mismatch" };
  db.handle().query("INSERT OR IGNORE INTO incident_tickets (incident_id, ticket_id, program_id, linked_at) VALUES (?, ?, ?, ?)")
    .run(incidentId, ticketId, inc.program_id, Date.now());
  return { ok: true };
}

function unlinkTicket({ incidentId, ticketId }) {
  db.handle().query("DELETE FROM incident_tickets WHERE incident_id = ? AND ticket_id = ?").run(incidentId, ticketId);
  return { ok: true };
}

function draftAnnouncement({ incidentId }) {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  const tickets = incidentTickets(incidentId);
  return {
    ok: true,
    draft: `Heads up: we're seeing ${tickets.length} similar report${tickets.length === 1 ? "" : "s"} about "${inc.title}". We're looking into it — please keep discussion in your threads and we'll update here. (Draft only — a human posts this.)`,
    ticketCount: tickets.length,
  };
}

module.exports = {
  suggestDuplicates,
  detectBursts,
  getIncident,
  listIncidents,
  incidentTickets,
  setIncidentStatus,
  linkTicket,
  unlinkTicket,
  draftAnnouncement,
  declareIncident,
  createIncident,
  matchActiveIncident,
  recordAffectedReport,
  affectedReports,
  notifyAffectedUsers,
};
