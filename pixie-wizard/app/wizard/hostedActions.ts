"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession, ownsIdentifier } from "@/lib/session";
import { creatorEligible, insertHostedProgram, claimHostedChannels } from "@/lib/programClaim";
import { sourceUrlProblem } from "@/lib/sourceUrls";
import { getHostedProgram, listHostedChannels, updateHostedProgram, markSyncState, logHostedAudit, addHostedHelper, setHelperVisibility as setHelperVisibilityRow } from "@/lib/hostedPrograms";
import { relationshipFor, linkedSlackSession } from "@/lib/programAccess";
import { query } from "@/lib/db";
import {
  syncProgramToCore, coreTicketAction, coreTicketReply, coreTicketNote, coreCopilot,
  coreChannelMembership, coreConfigured, coreHelpersSync, coreHelpers, coreRoutingExpertise,
  coreKnowledgePropose, coreKnowledgeReview, coreFaqPropose, coreMacroSave, coreMacroDelete,
  coreMacroSend, coreIncidentDetect, coreIncidentAction, coreIncidentNotify,
  coreRadarEvaluate, coreRadarAction, coreRetentionPolicy, coreRetentionSweep,
} from "@/lib/pixieCore";
import { validateActivationGuards } from "@/lib/activationGuards";
import type { ActionState } from "@/lib/types";
import type { DocSource } from "@/lib/types";

const CENTRAL_WORKSPACE = (process.env.PIXIE_WORKSPACE_ID || "default").trim() || "default";

// Creating a hosted program is invite-only (creatorEligible). Managing one you
// already own is NOT — ownership of this specific program is the authorization,
// so an owner who predates the creator allowlist can still change their
// settings. Only the creation actions call this.
async function requireHostedSession() {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  if (!creatorEligible(session)) throw new Error("This account is not eligible to create hosted programs.");
  return session;
}

// A hosted program must be manageable by its owner. Organizer/helper reads of
// other programs' tickets are enforced per-action below via Core membership.
async function requireProgramOwner(programId: string) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  const program = await getHostedProgram(programId);
  if (!program) throw new Error("Program not found");
  if (!ownsIdentifier(program.owner_hca_id, session)) throw new Error("Only the program owner can change these settings.");
  return { session, program };
}

// Owner or an active organizer (the "admin" relationship) — used for the
// smaller set of actions that don't need to be owner-exclusive, like
// choosing what shows on the public roster. Still server-authorized on
// every call, not just gated by what the page happens to render.
async function requireProgramOwnerOrAdmin(programId: string) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  const program = await getHostedProgram(programId);
  if (!program) throw new Error("Program not found");
  const relationship = await relationshipFor(program, session);
  if (relationship !== "owner" && relationship !== "admin") {
    throw new Error("Only the program owner or an admin can change this.");
  }
  return { session, program, relationship };
}

function parseSources(formData: FormData): { sources: DocSource[]; error: string | null } {
  const types = formData.getAll("sourceType").map(String);
  const urls = formData.getAll("sourceUrl").map(String);
  const labels = formData.getAll("sourceLabel").map(String);
  const sources: DocSource[] = [];
  for (let i = 0; i < Math.max(urls.length, types.length); i++) {
    const url = (urls[i] || "").trim();
    const type = (types[i] || "").trim() as DocSource["type"];
    // An empty optional row still submits a non-empty type — <select> always
    // has some value selected, even one nobody touched — so "no URL" is what
    // actually means "this row was left blank", not "type and URL both
    // blank". Skip it regardless of what the leftover type value is.
    if (!url) continue;
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
  const programSlug = String(formData.get("programSlug") ?? "").trim();
  const programDescription = String(formData.get("programDescription") ?? "").trim();
  const supportName = String(formData.get("supportName") ?? "").trim();
  const iconUrl = String(formData.get("iconUrl") ?? "").trim();

  const helpChannelId = String(formData.get("helpChannelId") ?? formData.get("helpChannelIdRaw") ?? "").trim();
  const organizerChannelId = String(formData.get("organizerChannelId") ?? formData.get("organizerChannelIdRaw") ?? "").trim();
  const rawExtra = formData.getAll("extraChannelId").map(String);
  const extraChannelIds: string[] = [];
  for (const item of rawExtra) {
    for (const part of item.split(/[\r\n,]+/)) {
      const t = part.trim();
      if (t) extraChannelIds.push(t);
    }
  }

  const allowPublicOrganizer = flagOn(formData, "allowPublicOrganizer", false);
  const aiAnswers = flagOn(formData, "aiAnswers", true);
  const ticketsEnabled = flagOn(formData, "ticketsEnabled", true);
  const autoEscalate = flagOn(formData, "autoEscalate", true);
  const autoAssign = flagOn(formData, "autoAssign", false);
  const posture = (String(formData.get("posture") ?? "active") || "active") as "active" | "passive" | "muted";
  const scope = (String(formData.get("scope") ?? "program") || "program") as "any" | "program";

  const rawHelpers = String(formData.get("initialHelperIds") ?? "");
  const helperIds = rawHelpers
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => /^[UW][A-Z0-9]{8,14}$/.test(s));

  const parsed = parseSources(formData);
  if (parsed.error) return { error: parsed.error };
  const sources = parsed.sources;

  // HARD ACTIVATION GUARDS
  const guard = await validateActivationGuards({
    workspaceId: CENTRAL_WORKSPACE,
    expectedWorkspaceId: CENTRAL_WORKSPACE,
    programName,
    programSlug: programSlug || null,
    programDescription: programDescription || null,
    helpChannelId,
    organizerChannelId,
    extraChannelIds,
    supportName: supportName || null,
    iconUrl: iconUrl || null,
    sources,
    allowPublicOrganizer,
    checkDbConflicts: true,
    membershipChecker: coreConfigured() ? coreChannelMembership : undefined,
  });

  if (!guard.ok) {
    return { error: guard.error ?? "Activation guard failed." };
  }

  const slug = guard.validatedSlug!;
  const channels = guard.channels!;

  let program;
  try {
    program = await insertHostedProgram({
      id: slug,
      workspaceId: CENTRAL_WORKSPACE,
      programName,
      programDescription: programDescription || null,
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
    await query(`delete from hosted_programs where id = $1 and workspace_id = $2`, [slug, CENTRAL_WORKSPACE]);
    return { error: `Channel <#${claim.conflictChannel}> is already owned by another program. Pick a different channel and activate again.` };
  }

  const patched = await updateHostedProgram(slug, {
    support_name: supportName || `${programName} Help`,
    icon_url: iconUrl || null,
    program_description: programDescription || null,
    ai_answers: aiAnswers,
    tickets_enabled: ticketsEnabled,
    auto_escalate: autoEscalate,
    posture: ["active", "passive", "muted"].includes(posture) ? posture : "active",
    scope: scope === "any" ? "any" : "program",
    sources,
    settings: {
      ...(programDescription ? { description: programDescription } : {}),
      autoAssign,
    },
  });

  // Helpers bootstrapping: creator as owner/organizer, initial helpers as helpers
  if (session.slackId) {
    await addHostedHelper({
      programId: slug,
      slackUserId: session.slackId,
      role: "owner",
      helperSource: "creator",
    }).catch(() => null);
  }
  for (const hId of helperIds) {
    await addHostedHelper({
      programId: slug,
      slackUserId: hId,
      role: "helper",
      helperSource: "manual",
    }).catch(() => null);
  }

  const allHelperMembers = [
    ...(session.slackId ? [session.slackId] : []),
    ...helperIds,
  ];
  if (allHelperMembers.length > 0) {
    await coreHelpersSync(slug, {
      actorId: session.slackId || allHelperMembers[0],
      members: allHelperMembers,
      source: "manual",
    }).catch(() => null);
  }

  await logHostedAudit({
    programId: slug,
    actorHcaId: session.hcaId,
    actorSlackId: session.slackId,
    action: "program.activated",
    entityType: "program",
    entityId: slug,
    metadata: {
      channels: channels.map((c) => c.id),
      hasIcon: Boolean(iconUrl),
      sourcesCount: sources.length,
      helpersCount: allHelperMembers.length,
    },
  });

  // Best-effort sync to Core
  const sync = await syncProgramToCore(slug, {
    name: patched.program_name,
    description: programDescription || null,
    workspaceId: CENTRAL_WORKSPACE,
    supportName: patched.support_name,
    iconUrl: patched.icon_url,
    helpChannel: helpChannelId,
    channels: channels.map((c) => c.id),
    posture: patched.posture,
    scope: patched.scope,
    aiAnswers,
    ticketsEnabled,
    autoEscalate,
    autoAssign,
    sources,
    claimedBy: session.slackId,
    workspace_id: CENTRAL_WORKSPACE,
    programChannels: channels,
  });
  await markSyncState(slug, sync, patched.core_synced_at);

  redirect(`/programs/${slug}`);
  return { error: null };
}

export async function saveHostedSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const programId = String(formData.get("programId") ?? "");
  // Authorization failures render as an inline error, not the route error
  // boundary. requireProgramOwner checks ownership of THIS program — not the
  // creator allowlist, so an owner who predates invite-only can still save.
  let session: Awaited<ReturnType<typeof requireProgramOwner>>["session"];
  let program: Awaited<ReturnType<typeof requireProgramOwner>>["program"];
  try {
    ({ session, program } = await requireProgramOwner(programId));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }

  const minutes = (name: string) => {
    const v = Number(formData.get(name) ?? "");
    return Number.isFinite(v) && v > 0 ? Math.round(v * 60000) : null;
  };
  const sla = {
    unassignedMs: minutes("slaUnassignedMin"),
    assignedMs: minutes("slaAssignedMin"),
    waitingMs: minutes("slaWaitingMin"),
  };
  const supportName = String(formData.get("supportName") ?? program.support_name ?? "").trim() || program.support_name;
  const iconUrl = String(formData.get("iconUrl") ?? program.icon_url ?? "").trim() || null;
  // A short catchphrase the program appends to its genuine answers only.
  // Empty clears it. Collapse any pasted newlines/runs of space to one space
  // so it stays a one-line sign-off, then trim and cap length.
  const replySignature = String(formData.get("replySignature") ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const programDescription = String(formData.get("programDescription") ?? program.program_description ?? "").trim() || null;
  if (iconUrl) {
    const iconProb = sourceUrlProblem(iconUrl);
    if (iconProb) return { error: `Invalid icon URL: ${iconProb}` };
  }
  const autoAssign = flagOn(formData, "autoAssign", false);
  const VALID_INCIDENT_MODES = ["ANSWER_ONLY", "ANSWER_AND_TRACK", "NORMAL_TICKET"] as const;
  const rawIncidentMode = String(formData.get("incidentMode") ?? program.incident_mode);
  const incidentMode = (VALID_INCIDENT_MODES as readonly string[]).includes(rawIncidentMode)
    ? (rawIncidentMode as (typeof VALID_INCIDENT_MODES)[number])
    : program.incident_mode;
  const patch = {
    support_name: supportName,
    icon_url: iconUrl,
    reply_signature: replySignature,
    program_description: programDescription,
    ai_answers: flagOn(formData, "aiAnswers", program.ai_answers),
    tickets_enabled: flagOn(formData, "ticketsEnabled", program.tickets_enabled),
    auto_escalate: flagOn(formData, "autoEscalate", program.auto_escalate),
    incident_mode: incidentMode,
    public_tickets_enabled: flagOn(formData, "publicTicketsEnabled", program.public_tickets_enabled),
    posture: (String(formData.get("posture") ?? program.posture) || program.posture) as "active" | "passive" | "muted",
    scope: (String(formData.get("scope") ?? program.scope) || program.scope) as "any" | "program",
    settings: {
      ...((program.settings as Record<string, unknown>) || {}),
      ...(programDescription ? { description: programDescription } : {}),
      autoAssign,
    },
  };
  const updated = await updateHostedProgram(programId, patch);
  await logHostedAudit({ programId, actorHcaId: session.hcaId, actorSlackId: session.slackId, action: "program.settings_updated", entityType: "program", entityId: programId });
  const sync = await syncProgramToCore(programId, {
    name: updated.program_name,
    description: updated.program_description ?? null,
    workspaceId: updated.workspace_id,
    supportName: updated.support_name,
    iconUrl: updated.icon_url,
    replySignature: updated.reply_signature,
    posture: updated.posture,
    scope: updated.scope,
    aiAnswers: updated.ai_answers,
    ticketsEnabled: updated.tickets_enabled,
    autoEscalate: updated.auto_escalate,
    incidentMode: updated.incident_mode,
    publicTicketsEnabled: updated.public_tickets_enabled,
    autoAssign,
    sensitiveCategories: String(formData.get("sensitiveCategories") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    sources: updated.sources,
    sla: Object.fromEntries(Object.entries(sla).filter(([, v]) => v !== null)),
  });
  await markSyncState(programId, sync, updated.core_synced_at);

  revalidatePath(`/programs/${programId}/settings`);
  revalidatePath(`/programs/${programId}`);
  return { error: null };
}

export async function saveHostedSources(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const programId = String(formData.get("programId") ?? "");
  let session: Awaited<ReturnType<typeof requireProgramOwner>>["session"];
  try {
    ({ session } = await requireProgramOwner(programId));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }
  const parsed = parseSources(formData);
  if (parsed.error) return { error: parsed.error };
  if (parsed.sources.length === 0) return { error: "Add at least one doc source." };
  const sources = parsed.sources;
  const updated = await updateHostedProgram(programId, { sources });
  await logHostedAudit({ programId, actorHcaId: session.hcaId, actorSlackId: session.slackId, action: "program.sources_updated", entityType: "program", entityId: programId, metadata: { count: sources.length } });
  const sync = await syncProgramToCore(programId, { name: updated.program_name, workspaceId: updated.workspace_id, sources });
  await markSyncState(programId, sync, updated.core_synced_at);
  revalidatePath(`/programs/${programId}/settings`);
  return { error: null };
}

// Ticket workspace actions. The acting Slack user is the logged-in owner's
// linked Slack id; Core re-verifies helper membership before mutating.
export async function hostedTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account to act on tickets." };
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
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account to reply." };
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
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account to add notes." };
  const programId = String(formData.get("programId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  const bodyText = String(formData.get("noteBody") ?? "").trim();
  if (!programId || !ticketId || !bodyText) return { error: "Write a note first." };
  try {
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
  const session = await linkedSlackSession();
  if (!session) return { ok: false, error: "Link your Slack account to use copilot." };
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
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  if (!programId || !ticketId) return { error: "Pick a resolved ticket first." };
  try {
    await coreKnowledgePropose(programId, { actorId: session.slackId, ticketId });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Proposal failed." };
  }
  revalidatePath(`/programs/${programId}/knowledge`);
  return { error: null };
}

export async function hostedCandidateReview(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const candidateId = Number(formData.get("candidateId") ?? "");
  const reviewAction = String(formData.get("reviewAction") ?? "");
  if (!programId || !candidateId || !["approve", "reject"].includes(reviewAction)) {
    return { error: "Missing review fields." };
  }
  try {
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
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const question = String(formData.get("faqQuestion") ?? "").trim();
  if (!programId || !question) return { error: "Missing FAQ question." };
  try {
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
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const id = Number(formData.get("macroId") ?? "");
  const trigger = String(formData.get("trigger") ?? "").trim();
  const name = String(formData.get("macroName") ?? "").trim();
  const content = String(formData.get("macroContent") ?? "").trim();
  if (!programId || !trigger || !name || !content) return { error: "Trigger, name, and content are required." };
  try {
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
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const id = Number(formData.get("macroId") ?? "");
  if (!programId || !id) return { error: "Missing macro fields." };
  try {
    await coreMacroDelete(id, { actorId: session.slackId });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Macro delete failed." };
  }
  revalidatePath(`/programs/${programId}/macros`);
  return { error: null };
}

export async function hostedMacroSend(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const id = Number(formData.get("macroId") ?? "");
  const ticketId = Number(formData.get("ticketId") ?? "");
  if (!programId || !id || !ticketId) return { error: "Pick a macro and a ticket first." };
  try {
    await coreMacroSend(id, { actorId: session.slackId, ticketId });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Macro send failed." };
  }
  revalidatePath(`/programs/${programId}/tickets/${ticketId}`);
  return { error: null };
}

// Helpers: manual membership, expertise tags, reconciliation.
export async function hostedHelperSave(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const userId = String(formData.get("helperUserId") ?? "").trim();
  const tags = String(formData.get("helperTags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!programId || !userId) return { error: "Helper user ID is required." };
  try {
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

// Incidents: detect/confirm/dismiss/resolve/link/unlink/declare. Announcement
// drafts return data for display; posting stays human.
export async function hostedIncidentAction(input: {
  programId: string;
  incidentId?: number;
  action: string;
  ticketId?: number;
  description?: string;
  publicMessage?: string;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const session = await linkedSlackSession();
  if (!session) return { ok: false, error: "Link your Slack account first." };
  try {
    if (input.action === "detect") {
      const data = await coreIncidentDetect(input.programId, { actorId: session.slackId });
      return { ok: true, data };
    }
    if (!input.incidentId) return { ok: false, error: "Missing incident." };
    const data = await coreIncidentAction(input.incidentId, {
      actorId: session.slackId,
      action: input.action,
      ticketId: input.ticketId,
      description: input.description,
      publicMessage: input.publicMessage,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Incident action failed." };
  }
}

// Affected-user resolution notice: an explicit, human-triggered, retry-safe
// broadcast to every thread that got the "known issue" answer while this
// incident was active. Never fires on its own.
export async function hostedIncidentNotify(input: {
  incidentId: number;
  resolutionMessage?: string;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const session = await linkedSlackSession();
  if (!session) return { ok: false, error: "Link your Slack account first." };
  try {
    const data = await coreIncidentNotify(input.incidentId, { actorId: session.slackId, resolutionMessage: input.resolutionMessage });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Notify failed." };
  }
}

// Support Radar: on-demand refresh plus acknowledge/resolve/suppress on one signal.
export async function hostedRadarAction(input: {
  programId: string;
  signalId?: number;
  action: "evaluate" | "acknowledge" | "resolve" | "suppress";
  duration?: "1h" | "24h" | "7d";
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const session = await linkedSlackSession();
  if (!session) return { ok: false, error: "Link your Slack account first." };
  try {
    if (input.action === "evaluate") {
      const data = await coreRadarEvaluate(input.programId, { actorId: session.slackId });
      return { ok: true, data };
    }
    if (!input.signalId) return { ok: false, error: "Missing signal." };
    const data = await coreRadarAction(input.signalId, { actorId: session.slackId, action: input.action, duration: input.duration });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Radar action failed." };
  }
}

// Retention: policy update (helpers) and confirmed sweep (organizers).
export async function hostedRetentionPolicy(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  if (!programId) return { error: "Missing program." };
  const policy: Record<string, number> = {};
  for (const key of ["contextDays", "ticketsDays", "notesDays", "tracesDays", "analyticsDays", "auditDays"]) {
    const v = Number(formData.get(key) ?? "");
    if (Number.isFinite(v) && v > 0) policy[key] = v;
  }
  try {
    await coreRetentionPolicy(programId, { actorId: session.slackId, policy });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Retention update failed." };
  }
  revalidatePath(`/programs/${programId}/retention`);
  return { error: null };
}

export async function hostedRetentionSweep(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!programId || confirm !== `DELETE ${programId}`) return { error: "Type the exact confirmation phrase to sweep." };
  try {
    await coreRetentionSweep(programId, { actorId: session.slackId, confirm: true });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Retention sweep failed." };
  }
  revalidatePath(`/programs/${programId}/retention`);
  return { error: null };
}

// Help-channel move: verify Pixie access, claim the new channel, release the
// old claim, keep ticket history untouched. Any failure leaves routing exactly
// as it was — claims are atomic on both sides.
export async function hostedChannelsUpdate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getSession();
  if (!session) return { error: "Unauthorized." };
  const programId = String(formData.get("programId") ?? "");
  const rawNew = String(formData.get("newHelpChannelId") ?? formData.get("newHelpChannelIdRaw") ?? "").trim();
  if (!programId || !rawNew) return { error: "Pick a new help channel." };

  const program = await getHostedProgram(programId);
  if (!program || !ownsIdentifier(program.owner_hca_id, session)) return { error: "Only the program owner can move channels." };
  const current = await listHostedChannels(programId);
  const oldHelp = current.find((c) => c.kind === "help");
  if (oldHelp && oldHelp.channel_id === rawNew) return { error: "That's already the help channel." };

  try {
    const membership = await coreChannelMembership(rawNew);
    if (!membership.ok || !membership.hasAccess) {
      return { error: "Pixie can't see that channel yet. Run /invite @Pixie there, then retry." };
    }
  } catch {
    return { error: "Could not verify channel access. Pixie Core may be down; try again shortly." };
  }

  const claim = await claimHostedChannels({
    workspaceId: program.workspace_id,
    programId,
    channels: [{ id: rawNew, kind: "help" }],
    claimedByHcaId: session.hcaId,
  });
  if (!claim.ok) {
    return { error: `Channel is already owned by another program.` };
  }

  const sync = await syncProgramToCore(programId, {
    name: program.program_name,
    workspaceId: program.workspace_id,
    helpChannel: rawNew,
    programChannels: [
      { id: rawNew, kind: "help" },
      ...(oldHelp ? [{ id: oldHelp.channel_id, kind: "release" }] : []),
    ],
  });
  if (!sync.ok) {
    await query(
      `delete from hosted_program_channels where workspace_id = $1 and channel_id = $2 and program_id = $3`,
      [program.workspace_id, rawNew, programId],
    );
    return { error: sync.error ?? "Core sync failed; routing unchanged." };
  }

  if (oldHelp) {
    await query(
      `delete from hosted_program_channels where workspace_id = $1 and channel_id = $2 and program_id = $3`,
      [program.workspace_id, oldHelp.channel_id, programId],
    );
  }
  await logHostedAudit({
    programId,
    actorHcaId: session.hcaId,
    actorSlackId: session.slackId,
    action: "program.help_channel_moved",
    entityType: "program",
    entityId: programId,
    metadata: { from: oldHelp?.channel_id ?? null, to: rawNew },
  });
  revalidatePath(`/programs/${programId}/settings`);
  return { error: null };
}

// Display-only toggle: whether a helper appears on the program's public
// profile roster. Never changes their actual role/active status — a hidden
// helper keeps every real permission they had. Owner or admin only, and
// setHelperVisibility() itself is scoped to (programId, slackUserId), so
// this can't be used to touch a different program's row even by mistake.
export async function setHelperVisibilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const programId = String(formData.get("programId") ?? "");
  const slackUserId = String(formData.get("slackUserId") ?? "");
  const visible = formData.get("visible") === "on";

  let session: Awaited<ReturnType<typeof requireProgramOwnerOrAdmin>>["session"];
  try {
    ({ session } = await requireProgramOwnerOrAdmin(programId));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }
  if (!slackUserId) return { error: "Missing helper." };

  await setHelperVisibilityRow(programId, slackUserId, visible);
  await logHostedAudit({
    programId,
    actorHcaId: session.hcaId,
    actorSlackId: session.slackId,
    action: visible ? "helper.shown_on_profile" : "helper.hidden_from_profile",
    entityType: "helper",
    entityId: slackUserId,
    metadata: { visible },
  });

  revalidatePath(`/programs/${programId}/helpers`);
  return { error: null };
}
