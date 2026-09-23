// Data access for hosted shared programs (control-plane Postgres). The
// Wizard owns configuration rows; Pixie Core owns runtime rows. Writes here
// never touch Railway, Slack tokens, or model keys — hosted programs have
// none.
import { query } from "@/lib/db";
import type { HostedProgramRow, HostedProgramChannel, HostedProgramHelper, PublicProgramProfile, WizardPerson } from "@/lib/types";

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

// Accepts either identity form (HCA id or email, case-insensitive) so a
// program whose owner_hca_id was set by email still shows up for its owner.
export async function listHostedProgramsForOwner(identity: { hcaId: string; email: string }): Promise<HostedProgramRow[]> {
  const { rows } = await query<HostedProgramRow>(
    `select * from hosted_programs where lower(owner_hca_id) in (lower($1), lower($2)) order by created_at desc`,
    [identity.hcaId, identity.email],
  );
  return rows;
}

// Program directory: every active program, regardless of who owns it.
// Membership only gates *management*, not discoverability — see
// lib/programAccess.ts, which is what turns this full row into either the
// real dashboard (members) or a safe public projection (everyone else).
// This function itself is still full-row and MUST NOT be sent to a client
// component directly.
export async function listActiveHostedPrograms(): Promise<HostedProgramRow[]> {
  const { rows } = await query<HostedProgramRow>(
    `select * from hosted_programs where status = 'active' order by program_name asc`,
  );
  return rows;
}

// The only sanctioned way to get program data safe for a non-member to see.
// A literal column allowlist in the SELECT — not a full-row fetch with
// fields hidden afterward — so a future column added to hosted_programs
// (say, a new internal setting) is private by default instead of leaking
// the moment someone forgets to strip it client-side.
export async function getPublicProgramProfile(id: string): Promise<PublicProgramProfile | null> {
  const { rows } = await query<{
    id: string;
    program_name: string;
    program_description: string | null;
    support_name: string | null;
    icon_url: string | null;
    status: HostedProgramRow["status"];
    sources: HostedProgramRow["sources"];
  }>(
    `select id, program_name, program_description, support_name, icon_url, status, sources
     from hosted_programs where id = $1 and status = 'active'`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  const helpChannel = await query<{ channel_id: string }>(
    `select channel_id from hosted_program_channels where program_id = $1 and kind = 'help' limit 1`,
    [id],
  );

  const roster = await query<{ role: "owner" | "organizer" | "helper" }>(
    `select role from hosted_program_helpers
     where program_id = $1 and active = true and visible_on_profile = true
     order by role`,
    [id],
  );

  const publicSources = Array.isArray(row.sources) ? row.sources.filter((s) => s.public === true) : [];

  return {
    id: row.id,
    programName: row.program_name,
    description: row.program_description ?? null,
    supportName: row.support_name,
    iconUrl: row.icon_url,
    status: row.status,
    publicHelpChannelId: helpChannel.rows[0]?.channel_id ?? null,
    publicSourceCount: publicSources.length,
    roster: roster.rows,
  };
}

// Server-page-only companion to getPublicProgramProfile(): the raw slack_user_id
// per visible helper, so the calling page can resolve display identity via
// Core (lib/pixieCore.ts's coreUserInfo) before ever constructing a client-
// safe roster entry. Deliberately NOT part of PublicProgramProfile — nothing
// with a slack_user_id in it may reach a client component.
export async function listVisibleHelperIdentityKeys(
  programId: string,
): Promise<Array<{ slackUserId: string; role: "owner" | "organizer" | "helper" }>> {
  const { rows } = await query<{ slack_user_id: string; role: "owner" | "organizer" | "helper" }>(
    `select slack_user_id, role from hosted_program_helpers
     where program_id = $1 and active = true and visible_on_profile = true
     order by role`,
    [programId],
  );
  return rows.map((r) => ({ slackUserId: r.slack_user_id, role: r.role }));
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
  "reply_signature",
  "program_description",
  "ai_answers",
  "tickets_enabled",
  "auto_escalate",
  "incident_mode",
  "public_tickets_enabled",
  "posture",
  "scope",
  "sensitive_categories",
  "sources",
  "guides",
  "milestones",
  "settings",
  "status",
  "behavior",
  "runtime_status",
  "core_sync_state",
  "core_sync_error",
  "core_synced_at",
]);
const JSONB_PROGRAM_COLUMNS = new Set(["sensitive_categories", "sources", "guides", "milestones", "settings", "behavior"]);

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

// Every Core sync attempt — activation, settings/sources saves, help-channel
// move, cron reconcile — ends by recording the same triple on the program
// row. One helper so a new sync site can't forget the error text or invert
// the keep-old-timestamp-on-failure rule. keepSyncedAt omitted means the
// timestamp column is left untouched (the reconcile-catch path, where even
// reading the row already failed).
export async function markSyncState(
  programId: string,
  sync: { ok: boolean; error?: string },
  keepSyncedAt?: string | null,
): Promise<HostedProgramRow> {
  if (sync.ok) {
    return updateHostedProgram(programId, {
      core_sync_state: "synced",
      core_sync_error: null,
      core_synced_at: new Date().toISOString(),
    });
  }
  return updateHostedProgram(programId, {
    core_sync_state: "failed",
    core_sync_error: sync.error ?? "unknown",
    ...(keepSyncedAt === undefined ? {} : { core_synced_at: keepSyncedAt }),
  });
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
  eligibleForPings?: boolean;
}): Promise<HostedProgramHelper> {
  const role = input.role ?? "helper";
  const helperSource = input.helperSource ?? "manual";
  // The eligible_for_pings column arrives via migration 004. Callers that do
  // not pass a preference keep the exact pre-migration statement, so old
  // flows stay green on databases the migration has not reached yet.
  if (input.eligibleForPings === undefined) {
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
  const { rows } = await query<HostedProgramHelper>(
    `insert into hosted_program_helpers (program_id, slack_user_id, role, helper_source, active, eligible_for_pings)
     values ($1, $2, $3, $4, true, $5)
     on conflict (program_id, slack_user_id)
     do update set role = excluded.role, helper_source = excluded.helper_source, active = true, removed_at = null,
       eligible_for_pings = excluded.eligible_for_pings
     returning *`,
    [input.programId, input.slackUserId, role, helperSource, input.eligibleForPings],
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

// One viewer's membership in one program — the targeted lookup behind
// relationshipFor(). Same active-only filter as listHostedHelpers(), but it
// never pulls more than the single row that decides this viewer's role, and
// it is scoped to (program_id, slack_user_id) so it can't return another
// program's row. Pages that render the whole roster still use
// listHostedHelpers().
export async function getHelperRow(programId: string, slackUserId: string): Promise<HostedProgramHelper | null> {
  const { rows } = await query<HostedProgramHelper>(
    `select * from hosted_program_helpers
     where program_id = $1 and slack_user_id = $2 and active = true
     limit 1`,
    [programId, slackUserId],
  );
  return rows[0] ?? null;
}

// Display-only — flips whether a helper appears on the public profile
// roster. Never touches `role`/`active`, so this can never be used to grant
// or revoke real permissions; it is explicitly scoped to one program so a
// caller can't accidentally (or maliciously) touch another program's row by
// passing the wrong slackUserId.
export async function setHelperVisibility(programId: string, slackUserId: string, visible: boolean): Promise<HostedProgramHelper> {
  const { rows } = await query<HostedProgramHelper>(
    `update hosted_program_helpers set visible_on_profile = $1
     where program_id = $2 and slack_user_id = $3
     returning *`,
    [visible, programId, slackUserId],
  );
  if (!rows[0]) throw new Error("helper not found for this program");
  return rows[0];
}

export async function setHostedHelperRole(programId: string, slackUserId: string, role: HostedProgramHelper["role"]): Promise<HostedProgramHelper> {
  const { rows } = await query<HostedProgramHelper>(`update hosted_program_helpers set role = $1 where program_id = $2 and slack_user_id = $3 and active = true returning *`, [role, programId, slackUserId]);
  if (!rows[0]) throw new Error("helper not found for this program");
  return rows[0];
}

export async function revokeHostedHelper(programId: string, slackUserId: string): Promise<HostedProgramHelper> {
  const { rows } = await query<HostedProgramHelper>(`update hosted_program_helpers set active = false, removed_at = now() where program_id = $1 and slack_user_id = $2 and active = true returning *`, [programId, slackUserId]);
  if (!rows[0]) throw new Error("active access not found for this program");
  return rows[0];
}

export async function upsertWizardPerson(input: { hcaId: string; email: string; displayName: string; slackUserId?: string | null; addedByHcaId?: string | null }): Promise<WizardPerson> {
  const hcaId = input.hcaId.trim();
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const slackUserId = input.slackUserId?.trim() || null;
  if (!hcaId || !email || !displayName) throw new Error("A verified HCA identity is required.");
  const { rows } = await query<WizardPerson>(
    `insert into wizard_people (hca_id, email, display_name, slack_user_id, added_by_hca_id)
     values ($1, $2, $3, $4, $5)
     on conflict (hca_id) do update set email = excluded.email, display_name = excluded.display_name,
       slack_user_id = coalesce(excluded.slack_user_id, wizard_people.slack_user_id), updated_at = now()
     returning *`,
    [hcaId, email, displayName, slackUserId, input.addedByHcaId ?? null],
  );
  return rows[0];
}

export async function listWizardPeople(search = ""): Promise<WizardPerson[]> {
  const q = `%${search.trim().toLowerCase()}%`;
  const { rows } = await query<WizardPerson>(
    `select * from wizard_people where lower(display_name) like $1 or lower(email) like $1 or lower(hca_id) like $1 or lower(coalesce(slack_user_id, '')) like $1 order by display_name asc`, [q],
  );
  return rows;
}

export async function getWizardPerson(hcaId: string): Promise<WizardPerson | null> {
  const { rows } = await query<WizardPerson>(`select * from wizard_people where hca_id = $1`, [hcaId]);
  return rows[0] ?? null;
}

export async function listProgramAccessForPerson(hcaId: string): Promise<Array<HostedProgramRow & { role: string }>> {
  const { rows } = await query<HostedProgramRow & { role: string }>(
    `select p.*, h.role from hosted_programs p join hosted_program_helpers h on h.program_id = p.id
     join wizard_people w on lower(w.slack_user_id) = lower(h.slack_user_id)
     where w.hca_id = $1 and h.active = true order by p.program_name asc`, [hcaId],
  );
  return rows;
}

// The wizard_people bridge above only covers helpers explicitly granted
// through the superadmin People & access page. A helper added directly by
// Slack ID (the normal path — see addHostedHelper) never gets a wizard_people
// row, so listProgramAccessForPerson silently reports them as having no
// program access even though relationshipFor()/getHelperRow() — the actual
// per-program access check — would recognize them immediately via
// session.slackId. This queries hosted_program_helpers directly, the same
// way, so "does this account help on anything" agrees with "can this account
// open its program."
export async function listProgramsForHelperSlackId(slackUserId: string): Promise<Array<HostedProgramRow & { role: string }>> {
  const { rows } = await query<HostedProgramRow & { role: string }>(
    `select p.*, h.role from hosted_programs p join hosted_program_helpers h on h.program_id = p.id
     where lower(h.slack_user_id) = lower($1) and h.active = true order by p.program_name asc`,
    [slackUserId],
  );
  return rows;
}

export async function setWizardSuperadmin(hcaId: string, actorHcaId: string, granted: boolean): Promise<void> {
  if (granted) await query(`insert into wizard_global_access (hca_id, role, granted_by_hca_id) values ($1, 'superadmin', $2) on conflict (hca_id) do update set role = 'superadmin', granted_by_hca_id = excluded.granted_by_hca_id`, [hcaId, actorHcaId]);
  else await query(`delete from wizard_global_access where hca_id = $1`, [hcaId]);
}

export async function isWizardSuperadmin(hcaId: string): Promise<boolean> {
  const { rows } = await query<{ hca_id: string }>(`select hca_id from wizard_global_access where hca_id = $1`, [hcaId]);
  const allow = (process.env.PIXIE_WIZARD_SUPERADMIN_ALLOWLIST || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  return rows.length > 0 || allow.includes(hcaId.toLowerCase());
}

export async function hasPersistedWizardSuperadmin(hcaId: string): Promise<boolean> {
  const { rows } = await query<{ hca_id: string }>(`select hca_id from wizard_global_access where hca_id = $1`, [hcaId]);
  return rows.length > 0;
}

function bootstrapSuperadminIds(): string[] {
  return (process.env.PIXIE_WIZARD_SUPERADMIN_ALLOWLIST || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
}

export function isBootstrapSuperadmin(hcaId: string): boolean {
  return bootstrapSuperadminIds().includes(hcaId.trim().toLowerCase());
}

export async function revokeWizardSuperadmin(hcaId: string, actorHcaId: string): Promise<void> {
  if (isBootstrapSuperadmin(hcaId)) throw new Error("This person is still granted by PIXIE_WIZARD_SUPERADMIN_ALLOWLIST; remove them from deployment configuration first.");
  const { rows } = await query<{ hca_id: string }>(`select hca_id from wizard_global_access where role = 'superadmin'`, []);
  const effective = new Set([...rows.map((r) => r.hca_id.toLowerCase()), ...bootstrapSuperadminIds()]);
  if (effective.size <= 1 && effective.has(hcaId.toLowerCase())) throw new Error("The final effective superadmin cannot be removed.");
  await query(`delete from wizard_global_access where hca_id = $1`, [hcaId]);
}
