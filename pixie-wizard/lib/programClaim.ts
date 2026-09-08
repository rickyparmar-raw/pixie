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

import { query, withTransaction, isUniqueViolation } from "@/lib/db";
import { isCreatorAllowed, type WizardSession } from "@/lib/session";
import { slugify } from "@/lib/slackManifest";
import type { HostedProgramRow } from "@/lib/types";

export interface ChannelClaim {
  id: string;
  kind: "help" | "organizer" | "discussion" | "announcement";
}

// One shape rule for derived and custom slugs alike — a display name and a
// hand-typed slug must clear the same bar, or activation and settings drift.
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/;

export function isSlugShape(slug: string): boolean {
  return SLUG_SHAPE.test(slug);
}

export function programSlugFor(name: string): string {
  const slug = slugify(name);
  if (!isSlugShape(slug)) {
    throw new Error("Program name must produce a 3-62 char lowercase slug.");
  }
  return slug;
}

export function validateOrDeriveSlug(name: string, customSlug?: string | null): string {
  if (customSlug && customSlug.trim()) {
    const raw = customSlug.trim();
    if (!isSlugShape(raw)) {
      throw new Error("Custom slug must be 3-62 characters, lowercase alphanumeric and hyphens (e.g. 'my-program').");
    }
    return raw;
  }
  const slug = slugify(name);
  if (!isSlugShape(slug)) {
    throw new Error("Program name must produce a 3-62 char lowercase slug (alphanumeric and hyphens).");
  }
  return slug;
}

export function creatorEligible(session: WizardSession): boolean {
  return isCreatorAllowed({ hcaId: session.hcaId, email: session.email });
}

// Check for channel claims by other programs before attempting activation.
export async function findChannelConflicts(
  workspaceId: string,
  programId: string,
  channelIds: string[],
): Promise<{ conflictChannel: string; ownerProgramId: string } | null> {
  for (const id of channelIds) {
    const { rows } = await query<{ program_id: string }>(
      `select program_id from hosted_program_channels where workspace_id = $1 and channel_id = $2`,
      [workspaceId, id],
    );
    const owner = rows[0];
    if (owner && owner.program_id !== programId) {
      return { conflictChannel: id, ownerProgramId: owner.program_id };
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
  const settings = input.programDescription ? { description: input.programDescription } : {};
  try {
    const { rows } = await query<HostedProgramRow>(
      `insert into hosted_programs
         (id, workspace_id, program_name, program_description, owner_hca_id, owner_slack_id, deployment_mode, status, settings)
       values ($1, $2, $3, $4, $5, $6, 'hosted_shared', 'active', $7)
       returning *`,
      [
        input.id,
        input.workspaceId,
        input.programName,
        input.programDescription ?? null,
        input.ownerHcaId,
        input.ownerSlackId,
        JSON.stringify(settings),
      ],
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error("That program is already active — it was created by your double-click.");
    throw err;
  }
}

// Claims every channel inside one attempt, inside one DB transaction: on the
// first conflict the whole transaction rolls back, so nothing partial is
// ever left behind for a retry to trip over. The unique (workspace_id,
// channel_id) primary key is still the real atomic guard against a
// concurrent claim racing this one — the pre-check just gives a friendlier
// error than a raw constraint violation when there's no race at all.
export async function claimHostedChannels(input: {
  workspaceId: string;
  programId: string;
  channels: ChannelClaim[];
  claimedByHcaId: string;
}): Promise<{ ok: true } | { ok: false; conflictChannel: string; ownerProgramId: string | null }> {
  try {
    return await withTransaction(async (client) => {
      // Pass 1: check every channel for a conflict before writing anything —
      // fails clean with zero side effects on the common "you picked a
      // channel someone else already claimed" path, no rollback required.
      // Channels this same program already owns (re-claiming on a settings
      // save, say) are noted so pass 2 skips them instead of re-inserting.
      const alreadyMine = new Set<string>();
      for (const ch of input.channels) {
        const existing = await client.query<{ program_id: string }>(
          `select program_id from hosted_program_channels where workspace_id = $1 and channel_id = $2`,
          [input.workspaceId, ch.id],
        );
        const owner = existing.rows[0];
        if (owner && owner.program_id !== input.programId) {
          return { ok: false, conflictChannel: ch.id, ownerProgramId: owner.program_id };
        }
        if (owner) alreadyMine.add(ch.id);
      }
      // Pass 2: nothing conflicted as of pass 1, so claim whatever isn't
      // already ours. A truly concurrent activation squeezing a claim in
      // between pass 1 and here still can't corrupt anything — the unique
      // (workspace_id, channel_id) primary key rejects the insert, this
      // whole transaction rolls back, and the catch below reports the real
      // winner.
      for (const ch of input.channels) {
        if (alreadyMine.has(ch.id)) continue;
        // Deliberately no ON CONFLICT here: a real conflict at this point
        // means a concurrent request won the race after pass 1 checked —
        // that must throw (unique_violation), not be silently swallowed,
        // or this would report {ok: true} for a channel it never actually
        // claimed.
        await client.query(
          `insert into hosted_program_channels (workspace_id, channel_id, program_id, kind, claimed_by_hca_id)
           values ($1, $2, $3, $4, $5)`,
          [input.workspaceId, ch.id, input.programId, ch.kind, input.claimedByHcaId],
        );
      }
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Lost a real race to a concurrent claim on the same channel — find out
      // who actually won it so the caller can report a useful owner.
      const winner = await Promise.all(
        input.channels.map((ch) =>
          query<{ program_id: string }>(
            `select program_id from hosted_program_channels where workspace_id = $1 and channel_id = $2 and program_id <> $3`,
            [input.workspaceId, ch.id, input.programId],
          ).then((r) => (r.rows[0] ? { id: ch.id, owner: r.rows[0].program_id } : null)),
        ),
      );
      const conflict = winner.find((w) => w !== null);
      return { ok: false, conflictChannel: conflict?.id ?? "", ownerProgramId: conflict?.owner ?? null };
    }
    throw err;
  }
}
