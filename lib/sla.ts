import db = require("./db");
import audit = require("./audit");

interface DbRow {
  id?: number;
  program_id?: string;
  status?: string;
  created_at?: number;
  first_response_at?: number | null;
  resolved_at?: number | null;
  [key: string]: unknown;
}

interface Thresholds extends DbRow {
  sla_unassigned_ms?: number | null;
  sla_assigned_ms?: number | null;
  sla_waiting_ms?: number | null;
  sla_notify_channel?: string | null;
}

interface SlaTicket extends DbRow {
  id: number;
  status: string;
  created_at: number;
  assigned_since: number;
}

interface Violation {
  ticketId: number;
  rule: string;
  ageMs: number;
  thresholdMs: number;
}

const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SLA_OPEN_STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
const SLA_ASSIGNED_STATUSES = ["assigned", "claimed", "escalated", "reopened"];
const SLA_LOOP_DEFAULT_MIN = 15;
const SLA_LEASE_NAME = "sla-check";
const SLA_DIGEST_PREVIEW_LINES = 5;

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
  return String(error);
}

function programThresholds(programId: string): Thresholds {
  const row = db
    .handle()
    .query(
      "SELECT sla_unassigned_ms, sla_assigned_ms, sla_waiting_ms, sla_target_ms, sla_notify_channel FROM programs WHERE id = ?",
    )
    .get(programId) as Thresholds | null;
  return row || {};
}

function openTickets(programId: string): SlaTicket[] {
  return db
    .handle()
    .query(
      `SELECT id, status, assignee_id, created_at, updated_at, COALESCE(assigned_at, created_at) AS assigned_since
     FROM tickets WHERE program_id = ? AND status IN (${SLA_OPEN_STATUSES.map(() => "?").join(",")})`,
    )
    .all(programId, ...SLA_OPEN_STATUSES) as SlaTicket[];
}

function violationForTicket(ticket: SlaTicket, t: Thresholds, now: number): Violation | null {
  const age = now - ticket.created_at;
  if (ticket.status === "open" && t.sla_unassigned_ms && age > t.sla_unassigned_ms) {
    return { ticketId: ticket.id, rule: "unassigned", ageMs: age, thresholdMs: t.sla_unassigned_ms };
  }
  if (
    SLA_ASSIGNED_STATUSES.includes(ticket.status) &&
    t.sla_assigned_ms &&
    now - ticket.assigned_since > t.sla_assigned_ms
  ) {
    return {
      ticketId: ticket.id,
      rule: "assigned_no_response",
      ageMs: now - ticket.assigned_since,
      thresholdMs: t.sla_assigned_ms,
    };
  }
  if (ticket.status === "waiting_for_helper" && t.sla_waiting_ms && age > t.sla_waiting_ms) {
    return { ticketId: ticket.id, rule: "waiting_for_helper", ageMs: age, thresholdMs: t.sla_waiting_ms };
  }
  return null;
}

function checkProgram({ programId, now = Date.now() }: { programId?: string; now?: number } = {}):
  { error: string } | { violations: Violation[]; notifyChannel: string | null } {
  if (!programId) return { error: "programId required" };
  const t = programThresholds(programId);
  const violations = [];
  for (const ticket of openTickets(programId)) {
    const violation = violationForTicket(ticket, t, now);
    if (violation) violations.push(violation);
  }
  return { violations, notifyChannel: t.sla_notify_channel || null };
}

function dueNotifications({
  programId,
  violations,
  now = Date.now(),
  cooldownMs = NOTIFY_COOLDOWN_MS,
}: { programId?: string; violations?: Violation[]; now?: number; cooldownMs?: number } = {}): Violation[] {
  const due = [];
  for (const v of violations || []) {
    const last = db
      .handle()
      .query("SELECT sent_at FROM sla_notifications WHERE program_id = ? AND ticket_id = ? AND rule = ?")
      .get(programId, v.ticketId, v.rule) as { sent_at: number } | null;
    if (!last || now - last.sent_at > cooldownMs) due.push(v);
  }
  return due;
}

function markNotified({
  programId,
  ticketId,
  rule,
  now = Date.now(),
}: {
  programId: string;
  ticketId: number;
  rule: string;
  now?: number;
}): void {
  db.handle()
    .query("INSERT OR REPLACE INTO sla_notifications (program_id, ticket_id, rule, sent_at) VALUES (?, ?, ?, ?)")
    .run(programId, ticketId, rule, now);
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId,
    actorId: null,
    action: "sla.notified",
    entityType: "ticket",
    entityId: ticketId,
    metadata: { rule },
  });
}

function suggestAction(violation: Violation, _ticket?: SlaTicket): string {
  if (violation.rule === "unassigned") return "recommend a helper or assign directly";
  if (violation.rule === "assigned_no_response") return "nudge the assignee or reassign";
  return "follow up or suggest closure to the requester";
}

function startSlaLoop(
  client: unknown,
  intervalMin = Number(process.env.PIXIE_SLA_CHECK_MIN || SLA_LOOP_DEFAULT_MIN),
): ReturnType<typeof setInterval> | null {
  if (!client || !intervalMin || intervalMin <= 0) return null;
  const log = require("./log");
  const lease = require("./jobLease");
  const timer = setInterval(
    () => {
      lease
        .runOnce(SLA_LEASE_NAME, intervalMin * 60 * 1000, async () => {
          const programs = require("./programs");
          const messages = require("./slackMessages");
          const reply = require("./reply");
          for (const prog of programs.all()) {
            if (!prog) continue;
            if (prog.shadowMode === true) continue;
            try {
              const swept = require("./assignmentLifecycle").sweepProgramTimeouts({ programId: prog.id });
              if (swept.swept > 0)
                log.info("assignmentLifecycle", `${prog.id}: timed out ${swept.swept} unclaimed offer(s)`);
            } catch (e: unknown) {
              log.warn("assignmentLifecycle", `timeout sweep failed for ${prog.id}: ${errorMessage(e)}`);
            }
            let checked;
            try {
              checked = checkProgram({ programId: prog.id });
            } catch (e: unknown) {
              log.warn("sla", `check failed for ${prog.id}: ${errorMessage(e)}`);
              continue;
            }
            if ("error" in checked || checked.violations.length === 0) continue;
            const due = dueNotifications({ programId: prog.id, violations: checked.violations });
            if (due.length === 0) continue;
            const channel = checked.notifyChannel || prog.helpChannel;
            if (!channel) continue;
            const lines = due.slice(0, SLA_DIGEST_PREVIEW_LINES).map((v) => {
              const ageMin = Math.round(v.ageMs / 60000);
              return `• ticket #${v.ticketId} (${v.rule}, waiting ${ageMin}m) — ${suggestAction(v)}`;
            });
            const more =
              due.length > SLA_DIGEST_PREVIEW_LINES ? `\n…and ${due.length - SLA_DIGEST_PREVIEW_LINES} more` : "";
            try {
              await messages.sendProgramMessage({
                client,
                program: prog,
                channel,
                text: reply.plainDashes(
                  `:alarm_clock: ${due.length} stale ticket${due.length === 1 ? "" : "s"} need attention\n${lines.join("\n")}${more}`,
                ),
              });
              for (const v of due) markNotified({ programId: prog.id, ticketId: v.ticketId, rule: v.rule });
            } catch (e: unknown) {
              log.warn("sla", `notify failed for ${prog.id}: ${errorMessage(e)}`);
            }
          }
        })
        .catch((e: unknown) => log.error("sla", `loop failed: ${errorMessage(e)}`));
    },
    intervalMin * 60 * 1000,
  );
  if (timer.unref) timer.unref();
  return timer;
}

export = { checkProgram, dueNotifications, markNotified, suggestAction, startSlaLoop, NOTIFY_COOLDOWN_MS };
