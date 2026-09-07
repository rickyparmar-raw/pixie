"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { creatorEligible, programSlugFor, insertHostedProgram, claimHostedChannels } from "@/lib/programClaim";
import { sourceUrlProblem } from "@/lib/sourceUrls";
import { getHostedProgram, updateHostedProgram, logHostedAudit } from "@/lib/hostedPrograms";
import { syncProgramToCore, coreTicketAction, coreTicketReply, coreTicketNote, coreCopilot } from "@/lib/pixieCore";
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
    const problem = sourceUrlProblem(url);
    if (problem) return { sources: [], error: `Row ${i + 1}: ${problem}` };
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

  const minutes = (name: string) => {
    const v = Number(formData.get(name) ?? "");
    return Number.isFinite(v) && v > 0 ? Math.round(v * 60000) : null;
  };
  const sla = {
    unassignedMs: minutes("slaUnassignedMin"),
    assignedMs: minutes("slaAssignedMin"),
    waitingMs: minutes("slaWaitingMin"),
  };
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
    autoAssign: flagOn(formData, "autoAssign", false),
    sensitiveCategories: String(formData.get("sensitiveCategories") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    sources: updated.sources,
    sla: Object.fromEntries(Object.entries(sla).filter(([, v]) => v !== null)),
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

// Helper copilot passthrough. Returns copilot data (draft/summary/verdicts)
// for client-side display — never sends anything to Slack.
export async function hostedCopilot(input: {
  programId: string;
  ticketId?: number;
  action: "draft" | "improve" | "summarize" | "factcheck" | "similar" | "ask";
  question?: string;
  text?: string;
  threadTs?: string;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const session = await getSession();
  if (!session?.slackId) return { ok: false, error: "Link your Slack account to use copilot." };
  try {
    const data = await coreCopilot(input.action, {
      programId: input.programId,
      actorId: session.slackId,
      ticketId: input.ticketId,
      question: input.question,
      text: input.text,
      threadTs: input.threadTs,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Copilot failed." };
  }
}

// Knowledge review: propose from a resolved ticket, approve/edit/reject a
// candidate, propose an FAQ draft from a gap cluster. Approval is the only
// path into the corpus.
export async function hostedKnowledgePropose(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  if (!programId || !ticketId) return { error: "Pick a resolved ticket first." };
  try {
    const { coreKnowledgePropose } = await import("@/lib/pixieCore");
    await coreKnowledgePropose(programId, { actorId: session.slackId, ticketId });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Proposal failed." };
  }
  revalidatePath(`/programs/${programId}/knowledge`);
  return { error: null };
}

export async function hostedCandidateReview(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const candidateId = Number(formData.get("candidateId") ?? "");
  const reviewAction = String(formData.get("reviewAction") ?? "");
  if (!programId || !candidateId || !["approve", "reject"].includes(reviewAction)) {
    return { error: "Missing review fields." };
  }
  try {
    const { coreKnowledgeReview } = await import("@/lib/pixieCore");
    await coreKnowledgeReview(candidateId, {
      actorId: session.slackId,
      action: reviewAction,
      edits: {
        question: String(formData.get("editQuestion") ?? "").trim() || undefined,
        answer: String(formData.get("editAnswer") ?? "").trim() || undefined,
        category: String(formData.get("editCategory") ?? "").trim() || undefined,
      },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Review failed." };
  }
  revalidatePath(`/programs/${programId}/knowledge`);
  return { error: null };
}

export async function hostedFaqPropose(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const question = String(formData.get("faqQuestion") ?? "").trim();
  if (!programId || !question) return { error: "Missing FAQ question." };
  try {
    const { coreFaqPropose } = await import("@/lib/pixieCore");
    await coreFaqPropose(programId, { actorId: session.slackId, question });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "FAQ proposal failed." };
  }
  revalidatePath(`/programs/${programId}/gaps`);
  return { error: null };
}

// Macros: organizer-managed, helper-invoked. Sends go through Core so program
// branding, permissions, and optional ticket transitions all apply.
export async function hostedMacroSave(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const id = Number(formData.get("macroId") ?? "");
  const trigger = String(formData.get("trigger") ?? "").trim();
  const name = String(formData.get("macroName") ?? "").trim();
  const content = String(formData.get("macroContent") ?? "").trim();
  if (!programId || !trigger || !name || !content) return { error: "Trigger, name, and content are required." };
  try {
    const { coreMacroSave } = await import("@/lib/pixieCore");
    await coreMacroSave(programId, {
      actorId: session.slackId,
      ...(id ? { id } : {}),
      trigger,
      name,
      description: String(formData.get("macroDescription") ?? "").trim() || null,
      content,
      on_send_transition: String(formData.get("macroTransition") ?? "").trim() || null,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Macro save failed." };
  }
  revalidatePath(`/programs/${programId}/macros`);
  return { error: null };
}

export async function hostedMacroDelete(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const id = Number(formData.get("macroId") ?? "");
  if (!programId || !id) return { error: "Missing macro fields." };
  try {
    const { coreMacroDelete } = await import("@/lib/pixieCore");
    await coreMacroDelete(id, { actorId: session.slackId });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Macro delete failed." };
  }
  revalidatePath(`/programs/${programId}/macros`);
  return { error: null };
}

export async function hostedMacroSend(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const id = Number(formData.get("macroId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  if (!programId || !id || !ticketId) return { error: "Pick a macro and a ticket first." };
  try {
    const { coreMacroSend } = await import("@/lib/pixieCore");
    await coreMacroSend(id, { actorId: session.slackId, ticketId });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Macro send failed." };
  }
  revalidatePath(`/programs/${programId}/tickets/${ticketId}`);
  return { error: null };
}

// Helpers: manual membership, expertise tags, reconciliation.
export async function hostedHelperSave(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const userId = String(formData.get("helperUserId") ?? "").trim();
  const tags = String(formData.get("helperTags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!programId || !userId) return { error: "Helper user ID is required." };
  try {
    const { coreHelpers, coreHelpersSync, coreRoutingExpertise } = await import("@/lib/pixieCore");
    const current = ((await coreHelpers(programId)) as Array<{ user_id: string }>) ?? [];
    const members = [...new Set([...current.map((h) => h.user_id), userId])];
    await coreHelpersSync(programId, { actorId: session.slackId, members, source: "manual" });
    if (tags.length > 0) {
      await coreRoutingExpertise(programId, { actorId: session.slackId, userId, tags });
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Helper save failed." };
  }
  revalidatePath(`/programs/${programId}/helpers`);
  return { error: null };
}

// Incidents: detect/confirm/dismiss/resolve/link/unlink. Announcement drafts
// return data for display; posting stays human.
export async function hostedIncidentAction(input: {
  programId: string;
  incidentId?: number;
  action: string;
  ticketId?: number;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const session = await getSession();
  if (!session?.slackId) return { ok: false, error: "Link your Slack account first." };
  try {
    const { coreIncidentDetect, coreIncidentAction } = await import("@/lib/pixieCore");
    if (input.action === "detect") {
      const data = await coreIncidentDetect(input.programId, { actorId: session.slackId });
      return { ok: true, data };
    }
    if (!input.incidentId) return { ok: false, error: "Missing incident." };
    const data = await coreIncidentAction(input.incidentId, {
      actorId: session.slackId,
      action: input.action,
      ticketId: input.ticketId,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Incident action failed." };
  }
}

// Retention: policy update (helpers) and confirmed sweep (organizers).
export async function hostedRetentionPolicy(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  if (!programId) return { error: "Missing program." };
  const policy: Record<string, number> = {};
  for (const key of ["contextDays", "ticketsDays", "notesDays", "tracesDays", "analyticsDays", "auditDays"]) {
    const v = Number(formData.get(key) ?? "");
    if (Number.isFinite(v) && v > 0) policy[key] = v;
  }
  try {
    const { coreRetentionPolicy } = await import("@/lib/pixieCore");
    await coreRetentionPolicy(programId, { actorId: session.slackId, policy });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Retention update failed." };
  }
  revalidatePath(`/programs/${programId}/retention`);
  return { error: null };
}

export async function hostedRetentionSweep(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session?.slackId) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!programId || confirm !== `DELETE ${programId}`) return { error: "Type the exact confirmation phrase to sweep." };
  try {
    const { coreRetentionSweep } = await import("@/lib/pixieCore");
    await coreRetentionSweep(programId, { actorId: session.slackId, confirm: true });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Retention sweep failed." };
  }
  revalidatePath(`/programs/${programId}/retention`);
  return { error: null };
}
