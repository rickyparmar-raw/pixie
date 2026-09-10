import * as pixieCore from "@/lib/pixieCore";
import type { CoreSlackProfile } from "@/lib/pixieCore";

// The one place the dashboard turns a Slack user id into something a person
// reads. Slack ids stay canonical everywhere in storage and in the API — this
// only decorates them for display. Server-side only, same as pixieCore.ts:
// imported by server components and the ticket server action, never a client
// component.

export type ResolvedIdentity = CoreSlackProfile & { label: string };

// display name -> real name -> username -> "@<id>". Never blank, never a
// fabricated name.
export function identityLabel(
  profile: Pick<CoreSlackProfile, "displayName" | "realName" | "username"> | null | undefined,
  slackId: string | null | undefined,
): string {
  if (!slackId) return "—";
  const name = profile?.displayName?.trim() || profile?.realName?.trim() || profile?.username?.trim();
  return name && name.length > 0 ? name : `@${slackId}`;
}

// Resolve a page's worth of Slack ids in one Core round trip. Every input id
// gets an entry — a real profile, or an id-only fallback — so callers never
// branch on "was it found". A Core failure (or Core not configured) degrades
// the whole map to id-only labels and never throws: an identity outage cannot
// take a page down.
export async function resolveIdentities(
  ids: Array<string | null | undefined>,
): Promise<Map<string, ResolvedIdentity>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const out = new Map<string, ResolvedIdentity>();
  let users: Record<string, CoreSlackProfile | null> = {};
  if (unique.length > 0 && pixieCore.coreConfigured()) {
    try {
      users = await pixieCore.coreUserInfoBatch(unique);
    } catch {
      users = {};
    }
  }
  for (const id of unique) {
    const profile = users[id] ?? null;
    out.set(id, {
      slackId: id,
      displayName: profile?.displayName ?? null,
      realName: profile?.realName ?? null,
      username: profile?.username ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      label: identityLabel(profile, id),
    });
  }
  return out;
}

// The reader for a resolved map: the human label for an id, falling back to
// "@<id>" for anything the map does not hold.
export function labelFor(map: Map<string, ResolvedIdentity>, id: string | null | undefined): string {
  if (!id) return "—";
  return map.get(id)?.label ?? `@${id}`;
}
