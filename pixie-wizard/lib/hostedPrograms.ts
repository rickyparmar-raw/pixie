// Data access for hosted shared programs (control-plane Postgres). The
// Wizard owns configuration rows; Pixie Core owns runtime rows. Writes here
// never touch Railway, Slack tokens, or model keys — hosted programs have
// none.
import { query } from "@/lib/db";
import type { HostedProgramRow, HostedProgramChannel, HostedProgramHelper } from "@/lib/types";

// jsonb columns: node-postgres auto-parses them back into JS values on read,
// but writes need an explicit JSON string — it does not serialize objects/
// arrays for you the way it does for scalars.
function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function getHostedProgram(id: string): Promise<HostedProgramRow | null> {
  const { rows } = await query<HostedProgramRow>(`select * from hosted_programs where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listHostedProgramsForOwner(ownerHcaId: string): Promise<HostedProgramRow[]> {
  const { rows } = await query<HostedProgramRow>(
    `select * from hosted_programs where owner_hca_id = $1 order by created_at desc`,
    [ownerHcaId],
  );
  return rows;
}

// Reconciliation queue: anything not confirmed synced to Core, whether it
// never got a first attempt (pending) or its last attempt errored (failed).
// Ordered oldest-first so a backlog drains in the order programs went stale,
// not newest-first where a noisy recent failure could starve an old one.
export async function listHostedProgramsPendingSync(): Promise<HostedProgramRow[]> {
  const { rows } = await query<HostedProgramRow>(
    `select * from hosted_programs where core_sync_state <> 'synced' order by updated_at asc`,
  );
  return rows;
}

// Columns that patches to this table are ever allowed to touch. Whitelisting
// here (rather than trusting whatever keys a caller passes) is what keeps a
// dynamic UPDATE safe from being handed something like "id" or
// "owner_hca_id" by a future call site — those must only ever be set at
// INSERT time.
const UPDATABLE_PROGRAM_COLUMNS = new Set([
  "support_name",
  "icon_url",
  "program_description",
  "ai_answers",
  "tickets_enabled",
  "auto_escalate",
  "posture",
  "scope",
  "sensitive_categories",
  "sources",
  "guides",
  "milestones",
  "settings",
  "status",
  "core_sync_state",
  "core_sync_error",
  "core_synced_at",
]);
const JSONB_PROGRAM_COLUMNS = new Set(["sensitive_categories", "sources", "guides", "milestones", "settings"]);

export async function updateHostedProgram(id: string, patch: Partial<HostedProgramRow>): Promise<HostedProgramRow> {
  const entries = Object.entries(patch).filter(([col]) => UPDATABLE_PROGRAM_COLUMNS.has(col));
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of entries) {
    params.push(JSONB_PROGRAM_COLUMNS.has(col) ? j(value) : value);
    sets.push(`${col} = $${params.length}`);
  }
  sets.push(`updated_at = now()`);
  params.push(id);
  const { rows } = await query<HostedProgramRow>(
    `update hosted_programs set ${sets.join(", ")} where id = $${params.length} returning *`,
    params,
  );
  if (!rows[0]) throw new Error(`hosted program ${id} not found`);
  return rows[0];
}

export async function listHostedChannels(programId: string): Promise<HostedProgramChannel[]> {
  const { rows } = await query<HostedProgramChannel>(
    `select * from hosted_program_channels where program_id = $1`,
    [programId],
  );
  return rows;
}

export async function logHostedAudit(input: {
  programId: string | null;
  actorHcaId: string | null;
  actorSlackId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await query(
    `insert into hosted_audit_events (program_id, actor_hca_id, actor_slack_id, action, entity_type, entity_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.programId,
      input.actorHcaId,
      input.actorSlackId ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      j(input.metadata ?? null),
    ],
  );
}

export async function listHostedAudit(programId: string, limit = 100): Promise<unknown[]> {
  const { rows } = await query(
    `select * from hosted_audit_events where program_id = $1 order by created_at desc limit $2`,
    [programId, limit],
  );
  return rows;
}

export async function addHostedHelper(input: {
  programId: string;
  slackUserId: string;
  role?: "helper" | "organizer" | "owner";
  helperSource?: "creator" | "organizer_channel" | "usergroup" | "manual";
}): Promise<HostedProgramHelper> {
  const role = input.role ?? "helper";
  const helperSource = input.helperSource ?? "manual";
  const { rows } = await query<HostedProgramHelper>(
    `insert into hosted_program_helpers (program_id, slack_user_id, role, helper_source, active)
     values ($1, $2, $3, $4, true)
     on conflict (program_id, slack_user_id)
     do update set role = excluded.role, helper_source = excluded.helper_source, active = true, removed_at = null
     returning *`,
    [input.programId, input.slackUserId, role, helperSource],
  );
  return rows[0];
}

export async function listHostedHelpers(programId: string): Promise<HostedProgramHelper[]> {
  const { rows } = await query<HostedProgramHelper>(
    `select * from hosted_program_helpers where program_id = $1 and active = true`,
    [programId],
  );
  return rows;
}
