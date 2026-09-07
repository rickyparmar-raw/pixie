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

export async function validateActivationGuards(
  input: ActivationGuardInput,
): Promise<ActivationGuardResult> {
  // 1. Workspace matching
  const workspaceId = (input.workspaceId || "").trim();
  if (!workspaceId) {
    return { ok: false, error: "Workspace ID is required." };
  }
  if (input.expectedWorkspaceId && workspaceId !== input.expectedWorkspaceId.trim()) {
    return {
      ok: false,
      error: `Workspace mismatch: program workspace (${workspaceId}) does not match active workspace (${input.expectedWorkspaceId}).`,
    };
  }

  // 2. Program Name
  const name = (input.programName || "").trim();
  if (!name) {
    return { ok: false, error: "Program name is required." };
  }
  if (name.length > 80) {
    return { ok: false, error: "Keep the program name under 80 characters." };
  }

  // 3. Program Slug
  let slug: string;
  try {
    slug = validateOrDeriveSlug(name, input.programSlug);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Bad program name or slug." };
  }

  // 4. Help Channel Required & Well-formed
  const helpId = (input.helpChannelId || "").trim();
  if (!helpId) {
    return { ok: false, error: "Help channel is required." };
  }
  if (!isValidSlackChannelId(helpId)) {
    return { ok: false, error: `Invalid help channel ID format (${helpId}). Expected a Slack channel ID like C0123456789.` };
  }

  // 5. Organizer Channel Required & Well-formed
  const organizerId = (input.organizerChannelId || "").trim();
  if (!organizerId) {
    return { ok: false, error: "Organizer channel is required." };
  }
  if (!isValidSlackChannelId(organizerId)) {
    return { ok: false, error: `Invalid organizer channel ID format (${organizerId}). Expected a Slack channel ID like C0123456789.` };
  }

  // 6. HARD GUARD: help != organizer (they MUST be different channels!)
  if (helpId === organizerId) {
    return {
      ok: false,
      error: "Help channel and organizer channel must be different channels. The organizer channel is private for helpers to coordinate.",
    };
  }

  // 7. Extra channels validation and deduplication
  const extraIds: string[] = [];
  const rawExtra = input.extraChannelIds || [];
  for (const raw of rawExtra) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!isValidSlackChannelId(trimmed)) {
      return { ok: false, error: `Invalid extra channel ID format (${trimmed}). Expected a Slack channel ID like C0123456789.` };
    }
    if (trimmed === helpId) {
      return { ok: false, error: `Extra channel (${trimmed}) duplicates the help channel. Each channel must be distinct.` };
    }
    if (trimmed === organizerId) {
      return { ok: false, error: `Extra channel (${trimmed}) duplicates the organizer channel. Each channel must be distinct.` };
    }
    if (extraIds.includes(trimmed)) {
      return { ok: false, error: `Duplicate extra channel detected (${trimmed}). Each channel must only be listed once.` };
    }
    extraIds.push(trimmed);
  }

  const channels: ChannelClaim[] = [
    { id: helpId, kind: "help" },
    { id: organizerId, kind: "organizer" },
    ...extraIds.map((id) => ({ id, kind: "discussion" as const })),
  ];

  // 8. Usable knowledge exists (at least one valid source)
  const sources = input.sources || [];
  if (sources.length === 0) {
    return { ok: false, error: "At least one usable knowledge source is required (e.g. web docs URL or GitHub repo)." };
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s) {
      return { ok: false, error: `Source #${i + 1} is empty.` };
    }
    if (!["url", "json-faq", "gdoc", "github-dir", "text"].includes(s.type)) {
      return { ok: false, error: `Source #${i + 1} has an unknown type (${s.type}).` };
    }
    if (s.type !== "text" && !s.url && !s.content) {
      return { ok: false, error: `Source #${i + 1} is missing its URL or content.` };
    }
    if (s.url) {
      const prob = sourceUrlProblem(s.url);
      if (prob) {
        return { ok: false, error: `Source #${i + 1} URL rejected: ${prob}` };
      }
    }
  }

  // 9. Support avatar / icon URL validation (optional)
  if (input.iconUrl && input.iconUrl.trim()) {
    const icon = input.iconUrl.trim();
    if (!icon.startsWith("https://")) {
      return { ok: false, error: "Support icon URL must be a secure https:// URL." };
    }
    const iconProb = sourceUrlProblem(icon);
    if (iconProb) {
      return { ok: false, error: `Support icon URL rejected: ${iconProb}` };
    }
  }

  // 10. Pre-check database channel claims against other programs
  if (input.checkDbConflicts !== false) {
    const allChannelIds = [helpId, organizerId, ...extraIds];
    const conflict = await findChannelConflicts(workspaceId, slug, allChannelIds);
    if (conflict) {
      const channelRole = conflict.conflictChannel === helpId ? "Help" : conflict.conflictChannel === organizerId ? "Organizer" : "Extra";
      return {
        ok: false,
        error: `${channelRole} channel <#${conflict.conflictChannel}> is already claimed by program "${conflict.ownerProgramId}". Cross-program channel reuse is not permitted.`,
      };
    }
  }

  // 11. Pixie membership in both channels & organizer channel privacy
  if (input.membershipChecker) {
    // Check help channel
    const helpMem = await input.membershipChecker(helpId);
    if (!helpMem.ok || !helpMem.hasAccess) {
      return {
        ok: false,
        error: `Pixie is not a member of the help channel (<#${helpId}>). Run /invite @Pixie there first, then retry.`,
      };
    }
    if (helpMem.isArchived) {
      return {
        ok: false,
        error: `Help channel (<#${helpId}>) is archived. Please select an active channel.`,
      };
    }

    // Check organizer channel
    const orgMem = await input.membershipChecker(organizerId);
    if (!orgMem.ok || !orgMem.hasAccess) {
      return {
        ok: false,
        error: `Pixie is not a member of the organizer channel (<#${organizerId}>). Run /invite @Pixie there first, then retry.`,
      };
    }
    if (orgMem.isArchived) {
      return {
        ok: false,
        error: `Organizer channel (<#${organizerId}>) is archived. Please select an active channel.`,
      };
    }

    // HARD GUARD: organizer channel must be valid and private where required
    if (orgMem.isPrivate === false && !input.allowPublicOrganizer) {
      return {
        ok: false,
        error: `Organizer channel (<#${organizerId}>) must be a private channel so helper discussions and ticket notes remain internal. Please select a private channel or invite @Pixie to your private channel.`,
      };
    }

    // Check extra channels membership if provided
    for (const extraId of extraIds) {
      const extraMem = await input.membershipChecker(extraId);
      if (!extraMem.ok || !extraMem.hasAccess) {
        return {
          ok: false,
          error: `Pixie is not a member of extra channel (<#${extraId}>). Run /invite @Pixie there first, then retry.`,
        };
      }
      if (extraMem.isArchived) {
        return {
          ok: false,
          error: `Extra channel (<#${extraId}>) is archived. Please select an active channel.`,
        };
      }
    }
  }

  return {
    ok: true,
    validatedSlug: slug,
    channels,
    normalizedSources: sources,
  };
}
