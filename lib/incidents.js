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

const DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const INCIDENT_WINDOW_MS = 60 * 60 * 1000;
const INCIDENT_THRESHOLD = 4;
const INCIDENT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function suggestDuplicates({ programId, ticketId = null, question, limit = 5 }) {
  if (!programId || !question) return { error: "programId and question required" };
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  const rows = db.handle().query(
    `SELECT id, question, summary, status, created_at FROM tickets
     WHERE program_id = ? AND created_at > ? AND status IN ('open','waiting_for_helper','assigned','claimed','escalated','reopened','resolved')
     ORDER BY created_at DESC LIMIT 200`,
  ).all(programId, cutoff);
  const ranked = rows
    .filter((t) => t.id !== ticketId)
    .map((t) => ({
      ticketId: t.id,
      question: t.question,
      summary: t.summary,
      status: t.status,
      createdAt: t.created_at,
      similarity: Number(gapClusters.pairOverlap(question, t.question).toFixed(3)),
    }))
    .filter((c) => c.similarity >= 0.35)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.min(Math.max(limit, 1), 10));
  return { candidates: ranked };
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
  const cutoff = Date.now() - windowMs;
  const rows = db.handle().query(
    `SELECT id, question, thread_ts, created_at FROM tickets
     WHERE program_id = ? AND created_at > ? AND status NOT IN ('closed','spam','duplicate')
     ORDER BY created_at ASC LIMIT 300`,
  ).all(programId, cutoff);
  if (rows.length < threshold) return { candidates: [] };

  const groups = gapClusters.clusterQuestions(rows.map((r) => r.question));
  // Map members back by position, not text: identical questions from different
  // tickets must not collapse onto the first row with that text.
  const questionIndex = new Map();
  rows.forEach((r, i) => {
    if (!questionIndex.has(r.question)) questionIndex.set(r.question, []);
    questionIndex.get(r.question).push(i);
  });
  const used = new Set();
  const out = [];
  for (const members of groups) {
    if (members.length < threshold) continue;
    const memberRows = [];
    for (const q of members) {
      const idx = (questionIndex.get(q) || []).find((i) => !used.has(i));
      if (idx === undefined) continue;
      used.add(idx);
      memberRows.push(rows[idx]);
    }
    if (memberRows.length < threshold) continue;
    const startedAt = Math.min(...memberRows.map((r) => r.created_at));
    const representative = memberRows.sort((a, b) => a.created_at - b.created_at)[0].question;
    // Cooldown: link into a live candidate with the same shape instead of
    // opening a second incident for the same burst.
    const live = db.handle().query(
      "SELECT * FROM program_incidents WHERE program_id = ? AND status IN ('candidate','confirmed') AND created_at > ? ORDER BY created_at DESC LIMIT 10",
    ).all(programId, Date.now() - INCIDENT_COOLDOWN_MS);
    const same = live.find((inc) => gapClusters.pairOverlap(inc.title, representative) >= 0.35);
    if (same) {
      let linked = 0;
      for (const r of memberRows) {
        const res = db.handle().query("INSERT OR IGNORE INTO incident_tickets (incident_id, ticket_id, program_id, linked_at) VALUES (?, ?, ?, ?)")
          .run(same.id, r.id, programId, Date.now());
        linked += res.changes;
      }
      out.push({ incidentId: same.id, title: same.title, status: same.status, linked, deduped: true });
      continue;
    }
    const res = db.handle().query(
      `INSERT INTO program_incidents (program_id, title, status, reason, confidence, started_at, created_at)
       VALUES (?, ?, 'candidate', ?, ?, ?, ?)`,
    ).run(programId, representative.slice(0, 200), `${memberRows.length} similar tickets in ${Math.round(windowMs / 60000)}m`, Math.min(0.5 + memberRows.length * 0.05, 0.95), startedAt, Date.now());
    const incidentId = Number(res.lastInsertRowid);
    for (const r of memberRows) {
      db.handle().query("INSERT OR IGNORE INTO incident_tickets (incident_id, ticket_id, program_id, linked_at) VALUES (?, ?, ?, ?)")
        .run(incidentId, r.id, programId, Date.now());
    }
    out.push({ incidentId, title: representative.slice(0, 200), status: "candidate", linked: memberRows.length, deduped: false });
  }
  return { candidates: out };
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
};
