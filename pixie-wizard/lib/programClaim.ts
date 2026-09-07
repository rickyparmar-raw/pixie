// Bootstrap authorization for hosted program creation (amendment 4).
//
// Before normal program membership exists there is no helper table to consult,
// so creation must not trust a bare "I own this channel" claim. The rules:
//  1. The creator holds a valid Wizard session that passes the allowlist.
//  2. The program slug is well-formed and (workspace, slug) is not live.
//  3. None of the claimed channels are owned by another live program — the
//     UNIQUE(workspace, channel) insert is the atomic guard, not a pre-check.
// A logged-in user therefore cannot hijack an arbitrary help channel: the
// claim either wins atomically or reports its owner.

import { db } from "@/lib/supabase";
import { isAllowed, type WizardSession } from "@/lib/session";
import { slugify } from "@/lib/slackManifest";
import type { HostedProgramRow } from "@/lib/types";

export interface ChannelClaim {
  id: string;
  kind: "help" | "organizer" | "discussion" | "announcement";
}

export function programSlugFor(name: string): string {
  const slug = slugify(name);
  if (!/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(slug)) {
    throw new Error("Program name must produce a 3-62 char lowercase slug.");
  }
  return slug;
}

export function validateOrDeriveSlug(name: string, customSlug?: string | null): string {
  if (customSlug && customSlug.trim()) {
    const raw = customSlug.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(raw)) {
      throw new Error("Custom slug must be 3-62 characters, lowercase alphanumeric and hyphens (e.g. 'my-program').");
    }
    return raw;
  }
  const slug = slugify(name);
  if (!/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(slug)) {
    throw new Error("Program name must produce a 3-62 char lowercase slug (alphanumeric and hyphens).");
  }
  return slug;
}

export function creatorEligible(session: WizardSession): boolean {
  return isAllowed({ hcaId: session.hcaId, email: session.email });
}

// Check for channel claims by other programs before attempting activation.
export async function findChannelConflicts(
  workspaceId: string,
  programId: string,
  channelIds: string[],
): Promise<{ conflictChannel: string; ownerProgramId: string } | null> {
  for (const id of channelIds) {
    const { data: owner } = await db
      .from("hosted_program_channels")
      .select("program_id")
      .eq("workspace_id", workspaceId)
      .eq("channel_id", id)
      .maybeSingle();
    if (owner && (owner as { program_id: string }).program_id !== programId) {
      return { conflictChannel: id, ownerProgramId: (owner as { program_id: string }).program_id };
    }
  }
  return null;
}

// Inserts the program row; throws when the slug is already live in this
// workspace (partial unique index) so double-submit Activate collapses.
export async function insertHostedProgram(input: {
  id: string;
  workspaceId: string;
  programName: string;
  programDescription?: string | null;
  ownerHcaId: string;
  ownerSlackId: string | null;
}): Promise<HostedProgramRow> {
  const { data, error } = await db
    .from("hosted_programs")
    .insert({
      id: input.id,
      workspace_id: input.workspaceId,
      program_name: input.programName,
      program_description: input.programDescription ?? null,
      owner_hca_id: input.ownerHcaId,
      owner_slack_id: input.ownerSlackId,
      deployment_mode: "hosted_shared",
      status: "active",
      settings: input.programDescription ? { description: input.programDescription } : {},
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("That program is already active — it was created by your double-click.");
    throw new Error(error.message);
  }
  return data as HostedProgramRow;
}

// Claims every channel inside one attempt: on the first conflict the rows
// already inserted for this program are removed so a retry starts clean.
export async function claimHostedChannels(input: {
  workspaceId: string;
  programId: string;
  channels: ChannelClaim[];
  claimedByHcaId: string;
}): Promise<{ ok: true } | { ok: false; conflictChannel: string; ownerProgramId: string | null }> {
  const claimed: string[] = [];
  for (const ch of input.channels) {
    const { data: owner } = await db
      .from("hosted_program_channels")
      .select("program_id")
      .eq("workspace_id", input.workspaceId)
      .eq("channel_id", ch.id)
      .maybeSingle();
    if (owner && (owner as { program_id: string }).program_id !== input.programId) {
      await db.from("hosted_program_channels").delete().eq("workspace_id", input.workspaceId).in("channel_id", claimed).eq("program_id", input.programId);
      return { ok: false, conflictChannel: ch.id, ownerProgramId: (owner as { program_id: string }).program_id };
    }
    if (!owner) {
      const { error } = await db.from("hosted_program_channels").insert({
        workspace_id: input.workspaceId,
        channel_id: ch.id,
        program_id: input.programId,
        kind: ch.kind,
        claimed_by_hca_id: input.claimedByHcaId,
      });
      if (error) {
        if (error.code === "23505") {
          await db.from("hosted_program_channels").delete().eq("workspace_id", input.workspaceId).in("channel_id", claimed).eq("program_id", input.programId);
          const { data: winner } = await db
            .from("hosted_program_channels")
            .select("program_id")
            .eq("workspace_id", input.workspaceId)
            .eq("channel_id", ch.id)
            .maybeSingle();
          return { ok: false, conflictChannel: ch.id, ownerProgramId: (winner as { program_id: string } | null)?.program_id ?? null };
        }
        throw new Error(error.message);
      }
      claimed.push(ch.id);
    }
  }
  return { ok: true };
}
