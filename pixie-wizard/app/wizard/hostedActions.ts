"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { creatorEligible, programSlugFor, insertHostedProgram, claimHostedChannels } from "@/lib/programClaim";
import { getHostedProgram, updateHostedProgram, logHostedAudit } from "@/lib/hostedPrograms";
import { syncProgramToCore, coreTicketAction, coreTicketReply, coreTicketNote } from "@/lib/pixieCore";
import type { ActionState } from "@/app/wizard/actions";
import type { DocSource } from "@/lib/types";

const CENTRAL_WORKSPACE = (process.env.PIXIE_WORKSPACE_ID || "default").trim() || "default";

async function requireHostedSession() {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  if (!creatorEligible(session)) throw new Error("This account is not eligible to create hosted programs.");
  return session;
}

// A hosted program must be readable by its owner. Organizer/helper reads of
// other programs' tickets are enforced per-action below via Core membership.
async function requireProgramOwner(programId: string) {
  const session = await requireHostedSession();
  const program = await getHostedProgram(programId);
  if (!program) throw new Error("Program not found");
  if (program.owner_hca_id !== session.hcaId) throw new Error("Only the program owner can change these settings.");
  return { session, program };
}

function parseSources(formData: FormData): { sources: DocSource[]; error: string | null } {
  const types = formData.getAll("sourceType").map(String);
  const urls = formData.getAll("sourceUrl").map(String);
  const labels = formData.getAll("sourceLabel").map(String);
  const sources: DocSource[] = [];
  for (let i = 0; i < Math.max(urls.length, types.length); i++) {
    const url = (urls[i] || "").trim();
    const type = (types[i] || "").trim() as DocSource["type"];
    if (!url && !type) continue;
    if (!["url", "json-faq", "gdoc", "github-dir", "text"].includes(type)) {
      return { sources: [], error: `Source row ${i + 1} has an unknown type.` };
    }
    if (!url) {
      return { sources: [], error: `Source row ${i + 1} is missing its URL.` };
    }
    try {
      new URL(url);
    } catch {
      return { sources: [], error: `Source row ${i + 1}'s URL doesn't look valid.` };
    }
    sources.push({ type, url, label: (labels[i] || "").trim() || undefined });
  }
  return { sources, error: null };
}

// Unchecked boxes submit only the hidden "off" value; checked boxes submit
// ["off", "on"]. Reading getAll means unchecking genuinely turns a flag off.
function flagOn(formData: FormData, name: string, fallback: boolean): boolean {
  const values = formData.getAll(name).map(String);
  if (values.length === 0) return fallback;
  return values.includes("on");
}

// One atomic Activate: program row → channel claims → config → Core sync.
// No Slack app, no tokens, no Railway, no AI keys. Double-submit collapses
// onto the existing row via the live-slug unique index.
export async function activateHostedProgram(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireHostedSession();

  const programName = String(formData.get("programName") ?? "").trim();
  const supportName = String(formData.get("supportName") ?? "").trim();
  if (!programName) return { error: "Program name is required." };
  if (programName.length > 80) return { error: "Keep the program name under 80 characters." };

  let slug: string;
  try {
    slug = programSlugFor(programName);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Bad program name." };
  }
  const helpChannelId = String(formData.get("helpChannelId") ?? formData.get("helpChannelIdRaw") ?? "").trim();
  const organizerChannelId = String(formData.get("organizerChannelId") ?? formData.get("organizerChannelIdRaw") ?? "").trim();
  if (!helpChannelId) return { error: "Pick a help channel." };
  if (!organizerChannelId) return { error: "Pick an organizer channel." };

  const extraIds = formData.getAll("extraChannelId").map(String).map((s) => s.trim()).filter(Boolean);
  const channels = [
    { id: helpChannelId, kind: "help" as const },
    { id: organizerChannelId, kind: "organizer" as const },
    ...extraIds.filter((id) => id !== helpChannelId && id !== organizerChannelId).map((id) => ({ id, kind: "discussion" as const })),
  ];

  const aiAnswers = flagOn(formData, "aiAnswers", true);
  const ticketsEnabled = flagOn(formData, "ticketsEnabled", true);
  const autoEscalate = flagOn(formData, "autoEscalate", true);
  const posture = (String(formData.get("posture") ?? "active") || "active") as "active" | "passive" | "muted";
  const scope = (String(formData.get("scope") ?? "program") || "program") as "any" | "program";
  const parsed = parseSources(formData);
  if (parsed.error) return { error: parsed.error };
  const sources = parsed.sources;

  let program;
  try {
    program = await insertHostedProgram({
      id: slug,
      workspaceId: CENTRAL_WORKSPACE,
      programName,
      ownerHcaId: session.hcaId,
      ownerSlackId: session.slackId,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not create the program." };
  }

  const claim = await claimHostedChannels({
    workspaceId: CENTRAL_WORKSPACE,
    programId: slug,
    channels,
    claimedByHcaId: session.hcaId,
  });
  if (!claim.ok) {
    return { error: `Channel <#${claim.conflictChannel}> is already owned by another program. Ask in that program's organizer channel or pick a different channel.` };
  }

  const patched = await updateHostedProgram(slug, {
    support_name: supportName || `${programName} Help`,
    ai_answers: aiAnswers,
    tickets_enabled: ticketsEnabled,
    auto_escalate: autoEscalate,
    posture: ["active", "passive", "muted"].includes(posture) ? posture : "active",
    scope: scope === "any" ? "any" : "program",
    sources,
  });

  await logHostedAudit({
    programId: slug,
    actorHcaId: session.hcaId,
    actorSlackId: session.slackId,
    action: "program.activated",
    entityType: "program",
    entityId: slug,
    metadata: { channels: channels.map((c) => c.id) },
  });

  // Best-effort: the program is live in the control plane regardless. A down
  // Core keeps serving from its last sync; this row retries via core_sync_state.
  const sync = await syncProgramToCore(slug, {
    name: patched.program_name,
    workspaceId: CENTRAL_WORKSPACE,
    supportName: patched.support_name,
    helpChannel: helpChannelId,
    channels: channels.map((c) => c.id),
    posture: patched.posture,
    scope: patched.scope,
    aiAnswers,
    ticketsEnabled,
    autoEscalate,
    sources,
    claimedBy: session.slackId,
    workspace_id: CENTRAL_WORKSPACE,
    programChannels: channels,
  });
  await updateHostedProgram(slug, {
    core_sync_state: sync.ok ? "synced" : "failed",
    core_sync_error: sync.ok ? null : (sync.error ?? "unknown"),
    core_synced_at: sync.ok ? new Date().toISOString() : patched.core_synced_at,
  });

  redirect(`/programs/${slug}`);
  return { error: null };
}

export async function saveHostedSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const programId = String(formData.get("programId") ?? "");
  const { session } = await requireProgramOwner(programId);
  const program = await getHostedProgram(programId);
  if (!program) return { error: "Program not found." };

  const patch = {
    support_name: String(formData.get("supportName") ?? program.support_name ?? "").trim() || program.support_name,
    ai_answers: flagOn(formData, "aiAnswers", program.ai_answers),
    tickets_enabled: flagOn(formData, "ticketsEnabled", program.tickets_enabled),
    auto_escalate: flagOn(formData, "autoEscalate", program.auto_escalate),
    posture: (String(formData.get("posture") ?? program.posture) || program.posture) as "active" | "passive" | "muted",
    scope: (String(formData.get("scope") ?? program.scope) || program.scope) as "any" | "program",
  };
  const updated = await updateHostedProgram(programId, patch);
  await logHostedAudit({ programId, actorHcaId: session.hcaId, actorSlackId: session.slackId, action: "program.settings_updated", entityType: "program", entityId: programId });
  const sync = await syncProgramToCore(programId, {
    name: updated.program_name,
    workspaceId: updated.workspace_id,
    supportName: updated.support_name,
    posture: updated.posture,
    scope: updated.scope,
    aiAnswers: updated.ai_answers,
    ticketsEnabled: updated.tickets_enabled,
    autoEscalate: updated.auto_escalate,
    sources: updated.sources,
  });
  await updateHostedProgram(programId, {
    core_sync_state: sync.ok ? "synced" : "failed",
    core_sync_error: sync.ok ? null : (sync.error ?? "unknown"),
    core_synced_at: sync.ok ? new Date().toISOString() : updated.core_synced_at,
  });

  revalidatePath(`/programs/${programId}`);
  return { error: null };
}

export async function saveHostedSources(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const programId = String(formData.get("programId") ?? "");
  const { session } = await requireProgramOwner(programId);
  const parsed = parseSources(formData);
  if (parsed.error) return { error: parsed.error };
  if (parsed.sources.length === 0) return { error: "Add at least one doc source." };
  const sources = parsed.sources;
  const updated = await updateHostedProgram(programId, { sources });
  await logHostedAudit({ programId, actorHcaId: session.hcaId, actorSlackId: session.slackId, action: "program.sources_updated", entityType: "program", entityId: programId, metadata: { count: sources.length } });
  const sync = await syncProgramToCore(programId, { name: updated.program_name, workspaceId: updated.workspace_id, sources });
  await updateHostedProgram(programId, {
    core_sync_state: sync.ok ? "synced" : "failed",
    core_sync_error: sync.ok ? null : (sync.error ?? "unknown"),
    core_synced_at: sync.ok ? new Date().toISOString() : updated.core_synced_at,
  });
  revalidatePath(`/programs/${programId}`);
  return { error: null };
}

// Ticket workspace actions. The acting Slack user is the logged-in owner's
// linked Slack id; Core re-verifies helper membership before mutating.
export async function hostedTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account to act on tickets." };
  const programId = String(formData.get("programId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  const action = String(formData.get("ticketAction") ?? "");
  if (!programId || !ticketId || !action) return { error: "Missing ticket action fields." };
  try {
    await coreTicketAction(ticketId, action, {
      programId,
      actorId: session.slackId,
      assigneeId: String(formData.get("assigneeId") ?? "").trim() || undefined,
      resolution: String(formData.get("resolution") ?? "").trim() || undefined,
      canonicalId: String(formData.get("canonicalId") ?? "").trim() || undefined,
      until: String(formData.get("until") ?? "").trim() || undefined,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Ticket action failed." };
  }
  revalidatePath(`/programs/${programId}/tickets/${ticketId}`);
  return { error: null };
}

export async function hostedTicketReply(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account to reply." };
  const programId = String(formData.get("programId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  const text = String(formData.get("replyText") ?? "").trim();
  if (!programId || !ticketId || !text) return { error: "Write a reply first." };
  try {
    await coreTicketReply(ticketId, { programId, actorId: session.slackId, text });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Reply failed." };
  }
  revalidatePath(`/programs/${programId}/tickets/${ticketId}`);
  return { error: null };
}

export async function hostedTicketNote(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account to add notes." };
  const programId = String(formData.get("programId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  const bodyText = String(formData.get("noteBody") ?? "").trim();
  if (!programId || !ticketId || !bodyText) return { error: "Write a note first." };
  try {
    const { coreTicketNote } = await import("@/lib/pixieCore");
    await coreTicketNote(ticketId, { programId, actorId: session.slackId, body: bodyText });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Note failed." };
  }
  revalidatePath(`/programs/${programId}/tickets/${ticketId}`);
  return { error: null };
}
