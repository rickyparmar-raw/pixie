// Per-program SLA and stale-ticket automation. Thresholds live on the program
// row; unset means the rule is off. Violations are computed from stored
// timestamps, notifications are cooldown-guarded per (program, ticket, rule),
// and delivery payloads are returned for the caller to send — this module
// never touches Slack itself, so it stays testable without a client.
const db = require("./db");
const audit = require("./audit");

const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function programThresholds(programId) {
  const row = db.handle().query(
    "SELECT sla_unassigned_ms, sla_assigned_ms, sla_waiting_ms, sla_target_ms, sla_notify_channel FROM programs WHERE id = ?",
  ).get(programId);
  return row || {};
}

function openTickets(programId) {
  return db.handle().query(
    `SELECT id, status, assignee_id, created_at, updated_at, COALESCE(assigned_at, created_at) AS assigned_since
     FROM tickets WHERE program_id = ? AND status IN ('open','waiting_for_helper','assigned','claimed','escalated','reopened')`,
  ).all(programId);
}

function checkProgram({ programId, now = Date.now() } = {}) {
  if (!programId) return { error: "programId required" };
  const t = programThresholds(programId);
  const violations = [];
  for (const ticket of openTickets(programId)) {
    const age = now - ticket.created_at;
    if (ticket.status === "open" && t.sla_unassigned_ms && age > t.sla_unassigned_ms) {
      violations.push({ ticketId: ticket.id, rule: "unassigned", ageMs: age, thresholdMs: t.sla_unassigned_ms });
    } else if (["assigned", "claimed", "escalated", "reopened"].includes(ticket.status) && t.sla_assigned_ms && now - ticket.assigned_since > t.sla_assigned_ms) {
      violations.push({ ticketId: ticket.id, rule: "assigned_no_response", ageMs: now - ticket.assigned_since, thresholdMs: t.sla_assigned_ms });
    } else if (ticket.status === "waiting_for_helper" && t.sla_waiting_ms && age > t.sla_waiting_ms) {
      violations.push({ ticketId: ticket.id, rule: "waiting_for_helper", ageMs: age, thresholdMs: t.sla_waiting_ms });
    }
  }
  return { violations, notifyChannel: t.sla_notify_channel || null };
}

function dueNotifications({ programId, violations, now = Date.now(), cooldownMs = NOTIFY_COOLDOWN_MS } = {}) {
  const due = [];
  for (const v of violations) {
    const last = db.handle().query("SELECT sent_at FROM sla_notifications WHERE program_id = ? AND ticket_id = ? AND rule = ?")
      .get(programId, v.ticketId, v.rule);
    if (!last || now - last.sent_at > cooldownMs) due.push(v);
  }
  return due;
}

function markNotified({ programId, ticketId, rule, now = Date.now() }) {
  db.handle().query(
    "INSERT OR REPLACE INTO sla_notifications (program_id, ticket_id, rule, sent_at) VALUES (?, ?, ?, ?)",
  ).run(programId, ticketId, rule, now);
  audit.record({ programId, actorId: null, action: "sla.notified", entityType: "ticket", entityId: ticketId, metadata: { rule } });
}

function suggestAction(violation, ticket) {
  if (violation.rule === "unassigned") return "recommend a helper or assign directly";
  if (violation.rule === "assigned_no_response") return "nudge the assignee or reassign";
  return "follow up or suggest closure to the requester";
}

// Background loop: single-flight across replicas via jobLease, quiet unless
// a program configured thresholds. Notifications go to the program's notify
// channel (or help channel) with cooldowns, so organizers hear once per day
// per ticket-rule, not once per check.
function startSlaLoop(client, intervalMin = Number(process.env.PIXIE_SLA_CHECK_MIN || 15)) {
  if (!client || !intervalMin || intervalMin <= 0) return null;
  const log = require("./log");
  const lease = require("./jobLease");
  const timer = setInterval(() => {
    lease.runOnce("sla-check", intervalMin * 60 * 1000, async () => {
      const programs = require("./programs");
      const messages = require("./slackMessages");
      const reply = require("./reply");
      for (const prog of programs.all()) {
        if (!prog || prog.id === "ysws-global") continue;
        let checked;
        try {
          checked = checkProgram({ programId: prog.id });
        } catch (_) {
          continue;
        }
        if (checked.error || checked.violations.length === 0) continue;
        const due = dueNotifications({ programId: prog.id, violations: checked.violations });
        if (due.length === 0) continue;
        const channel = checked.notifyChannel || prog.helpChannel;
        if (!channel) continue;
        const lines = due.slice(0, 5).map((v) => {
          const ageMin = Math.round(v.ageMs / 60000);
          return `• ticket #${v.ticketId} (${v.rule}, waiting ${ageMin}m) — ${suggestAction(v)}`;
        });
        const more = due.length > 5 ? `\n…and ${due.length - 5} more` : "";
        try {
          await messages.sendProgramMessage({
            client,
            program: prog,
            channel,
            text: reply.plainDashes(`:alarm_clock: ${due.length} stale ticket${due.length === 1 ? "" : "s"} need attention\n${lines.join("\n")}${more}`),
          });
          for (const v of due) markNotified({ programId: prog.id, ticketId: v.ticketId, rule: v.rule });
        } catch (e) {
          log.warn("sla", `notify failed for ${prog.id}: ${e.message}`);
        }
      }
    }).catch((e) => log.error("sla", `loop failed: ${e.message}`));
  }, intervalMin * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { checkProgram, dueNotifications, markNotified, suggestAction, startSlaLoop, NOTIFY_COOLDOWN_MS };
