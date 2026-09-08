// Reconciliation for hosted programs whose config hasn't reached Core yet —
// activation (or a later settings save) recorded core_sync_state=pending/
// failed instead of retrying inline, so something has to come back for them.
// This is intentionally separate from the deleted dedicated/Railway trial
// sweeper: that swept ephemeral trial provisioning state, this only ever
// re-sends a hosted program's already-canonical Supabase row to Core.
//
// Idempotent by construction: syncProgramToCore does a PUT keyed by program
// id (Core's internalProgramSync upserts on that id), so re-sending the same
// row twice is a no-op beyond overwriting Core's copy with the same values.
import { listHostedProgramsPendingSync, listActiveHostedPrograms, listHostedChannels, markSyncState } from "@/lib/hostedPrograms";
import { syncProgramToCore, coreConfigured } from "@/lib/pixieCore";
import type { HostedProgramChannel } from "@/lib/types";

export interface ReconcileResult {
  attempted: number;
  synced: number;
  stillFailed: number;
  errors: Array<{ programId: string; error: string }>;
}

function buildSyncPayload(
  program: Awaited<ReturnType<typeof listHostedProgramsPendingSync>>[number],
  channels: HostedProgramChannel[],
): Record<string, unknown> {
  const helpChannel = channels.find((c) => c.kind === "help")?.channel_id ?? "";
  const settings = (program.settings ?? {}) as Record<string, unknown>;
  return {
    name: program.program_name,
    description: program.program_description ?? null,
    workspaceId: program.workspace_id,
    supportName: program.support_name,
    iconUrl: program.icon_url,
    replySignature: program.reply_signature,
    helpChannel,
    channels: channels.map((c) => c.channel_id),
    posture: program.posture,
    scope: program.scope,
    aiAnswers: program.ai_answers,
    ticketsEnabled: program.tickets_enabled,
    autoEscalate: program.auto_escalate,
    incidentMode: program.incident_mode,
    publicTicketsEnabled: program.public_tickets_enabled,
    autoAssign: settings.autoAssign === true,
    sources: program.sources,
    claimedBy: program.owner_slack_id,
    workspace_id: program.workspace_id,
    programChannels: channels.map((c) => ({ id: c.channel_id, kind: c.kind })),
  };
}

// Best-effort, one pass over the backlog or all programs. Safe to call repeatedly
// (cron) or on demand — never throws, every program's outcome is recorded on
// its own row so one bad program can't block the rest of the batch.
export async function reconcileHostedSync(opts: { forceAll?: boolean } = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { attempted: 0, synced: 0, stillFailed: 0, errors: [] };
  if (!coreConfigured()) return result;

  const pending = opts.forceAll ? await listActiveHostedPrograms() : await listHostedProgramsPendingSync();
  for (const program of pending) {
    result.attempted += 1;
    try {
      const channels = await listHostedChannels(program.id);
      const payload = buildSyncPayload(program, channels);
      const sync = await syncProgramToCore(program.id, payload);
      await markSyncState(program.id, sync, program.core_synced_at);
      if (sync.ok) result.synced += 1;
      else {
        result.stillFailed += 1;
        result.errors.push({ programId: program.id, error: sync.error ?? "unknown" });
      }
    } catch (err) {
      result.stillFailed += 1;
      const message = err instanceof Error ? err.message : "unknown error";
      result.errors.push({ programId: program.id, error: message });
      await markSyncState(program.id, { ok: false, error: message }).catch(() => null);
    }
  }
  return result;
}
