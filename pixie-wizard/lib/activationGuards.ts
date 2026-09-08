// Hard activation guards for hosted shared programs.
// Enforces program validation, channel uniqueness, Pixie membership,
// private organizer channel requirement, usable knowledge sources, and workspace safety.

import { sourceUrlProblem } from "@/lib/sourceUrls";
import { validateOrDeriveSlug, findChannelConflicts, type ChannelClaim } from "@/lib/programClaim";
import type { DocSource } from "@/lib/types";

export interface ChannelMembershipInfo {
  ok: boolean;
  hasAccess: boolean;
  name?: string | null;
  isPrivate?: boolean;
  isArchived?: boolean;
  reason?: string;
}

export type MembershipChecker = (channelId: string) => Promise<ChannelMembershipInfo>;

export interface ActivationGuardInput {
  workspaceId: string;
  expectedWorkspaceId?: string;
  programName: string;
  programSlug?: string | null;
  programDescription?: string | null;
  helpChannelId: string;
  organizerChannelId: string;
  extraChannelIds?: string[];
  supportName?: string | null;
  iconUrl?: string | null;
  sources: DocSource[];
  allowPublicOrganizer?: boolean;
  checkDbConflicts?: boolean;
  membershipChecker?: MembershipChecker;
}

export interface ActivationGuardResult {
  ok: boolean;
  error?: string;
  validatedSlug?: string;
  channels?: ChannelClaim[];
  normalizedSources?: DocSource[];
}

const SLACK_CHANNEL_REGEX = /^[CG][A-Z0-9]{8,14}$/;

export function isValidSlackChannelId(id: string): boolean {
  return SLACK_CHANNEL_REGEX.test(id);
}

// Steps run in fixed order so a form with several problems reports the most
// fundamental one first (workspace → name → channels → sources → Core state).
function workspaceError(input: ActivationGuardInput): string | null {
  const workspaceId = (input.workspaceId || "").trim();
  if (!workspaceId) return "Workspace ID is required.";
  if (input.expectedWorkspaceId && workspaceId !== input.expectedWorkspaceId.trim()) {
    return `Workspace mismatch: program workspace (${workspaceId}) does not match active workspace (${input.expectedWorkspaceId}).`;
  }
  return null;
}

function programNameError(input: ActivationGuardInput): string | null {
  const name = (input.programName || "").trim();
  if (!name) return "Program name is required.";
  if (name.length > 80) return "Keep the program name under 80 characters.";
  return null;
}

interface CheckedChannels {
  helpId: string;
  organizerId: string;
  extraIds: string[];
  channels: ChannelClaim[];
}

function checkChannelIds(input: ActivationGuardInput): { error: string } | CheckedChannels {
  const helpId = (input.helpChannelId || "").trim();
  if (!helpId) return { error: "Help channel is required." };
  if (!isValidSlackChannelId(helpId)) {
    return { error: `Invalid help channel ID format (${helpId}). Expected a Slack channel ID like C0123456789.` };
  }

  const organizerId = (input.organizerChannelId || "").trim();
  if (!organizerId) return { error: "Organizer channel is required." };
  if (!isValidSlackChannelId(organizerId)) {
    return { error: `Invalid organizer channel ID format (${organizerId}). Expected a Slack channel ID like C0123456789.` };
  }

  // Help and organizer serve opposite audiences — sharing one channel would
  // expose internal coordination to the public help feed.
  if (helpId === organizerId) {
    return {
      error: "Help channel and organizer channel must be different channels. The organizer channel is private for helpers to coordinate.",
    };
  }

  const extraIds: string[] = [];
  for (const raw of input.extraChannelIds || []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!isValidSlackChannelId(trimmed)) {
      return { error: `Invalid extra channel ID format (${trimmed}). Expected a Slack channel ID like C0123456789.` };
    }
    if (trimmed === helpId) {
      return { error: `Extra channel (${trimmed}) duplicates the help channel. Each channel must be distinct.` };
    }
    if (trimmed === organizerId) {
      return { error: `Extra channel (${trimmed}) duplicates the organizer channel. Each channel must be distinct.` };
    }
    if (extraIds.includes(trimmed)) {
      return { error: `Duplicate extra channel detected (${trimmed}). Each channel must only be listed once.` };
    }
    extraIds.push(trimmed);
  }

  return {
    helpId,
    organizerId,
    extraIds,
    channels: [
      { id: helpId, kind: "help" },
      { id: organizerId, kind: "organizer" },
      ...extraIds.map((id) => ({ id, kind: "discussion" as const })),
    ],
  };
}

function sourcesError(sources: DocSource[]): string | null {
  if (sources.length === 0) {
    return "At least one usable knowledge source is required (e.g. web docs URL or GitHub repo).";
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s) return `Source #${i + 1} is empty.`;
    if (!["url", "json-faq", "gdoc", "github-dir", "text"].includes(s.type)) {
      return `Source #${i + 1} has an unknown type (${s.type}).`;
    }
    if (s.type !== "text" && !s.url && !s.content) {
      return `Source #${i + 1} is missing its URL or content.`;
    }
    if (s.url) {
      const prob = sourceUrlProblem(s.url);
      if (prob) return `Source #${i + 1} URL rejected: ${prob}`;
    }
  }
  return null;
}

function iconError(iconUrl?: string | null): string | null {
  if (!iconUrl || !iconUrl.trim()) return null;
  const icon = iconUrl.trim();
  if (!icon.startsWith("https://")) return "Support icon URL must be a secure https:// URL.";
  const prob = sourceUrlProblem(icon);
  if (prob) return `Support icon URL rejected: ${prob}`;
  return null;
}

// Live Pixie membership for every claimed channel, plus the privacy rule
// that keeps helper coordination out of public channels.
async function membershipError(
  checked: CheckedChannels,
  membershipChecker: MembershipChecker,
  allowPublicOrganizer?: boolean,
): Promise<string | null> {
  const helpMem = await membershipChecker(checked.helpId);
  if (!helpMem.ok || !helpMem.hasAccess) {
    return `Pixie is not a member of the help channel (<#${checked.helpId}>). Run /invite @Pixie there first, then retry.`;
  }
  if (helpMem.isArchived) {
    return `Help channel (<#${checked.helpId}>) is archived. Please select an active channel.`;
  }

  const orgMem = await membershipChecker(checked.organizerId);
  if (!orgMem.ok || !orgMem.hasAccess) {
    return `Pixie is not a member of the organizer channel (<#${checked.organizerId}>). Run /invite @Pixie there first, then retry.`;
  }
  if (orgMem.isArchived) {
    return `Organizer channel (<#${checked.organizerId}>) is archived. Please select an active channel.`;
  }
  if (orgMem.isPrivate === false && !allowPublicOrganizer) {
    return `Organizer channel (<#${checked.organizerId}>) must be a private channel so helper discussions and ticket notes remain internal. Please select a private channel or invite @Pixie to your private channel.`;
  }

  for (const extraId of checked.extraIds) {
    const extraMem = await membershipChecker(extraId);
    if (!extraMem.ok || !extraMem.hasAccess) {
      return `Pixie is not a member of extra channel (<#${extraId}>). Run /invite @Pixie there first, then retry.`;
    }
    if (extraMem.isArchived) {
      return `Extra channel (<#${extraId}>) is archived. Please select an active channel.`;
    }
  }
  return null;
}

export async function validateActivationGuards(
  input: ActivationGuardInput,
): Promise<ActivationGuardResult> {
  const wsErr = workspaceError(input);
  if (wsErr) return { ok: false, error: wsErr };

  const nameErr = programNameError(input);
  if (nameErr) return { ok: false, error: nameErr };

  let slug: string;
  try {
    slug = validateOrDeriveSlug(input.programName, input.programSlug);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Bad program name or slug." };
  }

  const checked = checkChannelIds(input);
  if ("error" in checked) return { ok: false, error: checked.error };

  const srcErr = sourcesError(input.sources || []);
  if (srcErr) return { ok: false, error: srcErr };

  const icErr = iconError(input.iconUrl);
  if (icErr) return { ok: false, error: icErr };

  // Pre-check before any write: friendly error on the common path, while the
  // unique (workspace, channel) key remains the real guard under concurrency.
  if (input.checkDbConflicts !== false) {
    const conflict = await findChannelConflicts(
      (input.workspaceId || "").trim(),
      slug,
      [checked.helpId, checked.organizerId, ...checked.extraIds],
    );
    if (conflict) {
      const channelRole = conflict.conflictChannel === checked.helpId ? "Help" : conflict.conflictChannel === checked.organizerId ? "Organizer" : "Extra";
      return {
        ok: false,
        error: `${channelRole} channel <#${conflict.conflictChannel}> is already claimed by program "${conflict.ownerProgramId}". Cross-program channel reuse is not permitted.`,
      };
    }
  }

  if (input.membershipChecker) {
    const memErr = await membershipError(checked, input.membershipChecker, input.allowPublicOrganizer);
    if (memErr) return { ok: false, error: memErr };
  }

  return {
    ok: true,
    validatedSlug: slug,
    channels: checked.channels,
    normalizedSources: input.sources,
  };
}
