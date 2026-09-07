// Data access for hosted shared programs (migration 002). The Wizard owns
// configuration rows; Pixie Core owns runtime rows. Writes here never touch
// Railway, Slack tokens, or model keys — hosted programs have none.
import { db } from "@/lib/supabase";
import type { HostedProgramRow, HostedProgramChannel } from "@/lib/types";

export async function getHostedProgram(id: string): Promise<HostedProgramRow | null> {
  const { data, error } = await db.from("hosted_programs").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data as HostedProgramRow | null;
}

export async function listHostedProgramsForOwner(ownerHcaId: string): Promise<HostedProgramRow[]> {
  const { data, error } = await db
    .from("hosted_programs")
    .select("*")
    .eq("owner_hca_id", ownerHcaId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as HostedProgramRow[]) ?? [];
}

export async function updateHostedProgram(id: string, patch: Partial<HostedProgramRow>): Promise<HostedProgramRow> {
  const { data, error } = await db
    .from("hosted_programs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as HostedProgramRow;
}

export async function listHostedChannels(programId: string): Promise<HostedProgramChannel[]> {
  const { data, error } = await db.from("hosted_program_channels").select("*").eq("program_id", programId);
  if (error) throw new Error(error.message);
  return (data as HostedProgramChannel[]) ?? [];
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
  await db.from("hosted_audit_events").insert({
    program_id: input.programId,
    actor_hca_id: input.actorHcaId,
    actor_slack_id: input.actorSlackId ?? null,
    action: input.action,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    metadata: input.metadata ?? null,
  });
}

export async function listHostedAudit(programId: string, limit = 100): Promise<unknown[]> {
  const { data, error } = await db
    .from("hosted_audit_events")
    .select("*")
    .eq("program_id", programId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}
