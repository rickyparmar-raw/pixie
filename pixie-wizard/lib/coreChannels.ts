import { unstable_cache } from "next/cache";
import { coreSlackChannels, type CoreChannel } from "@/lib/pixieCore";

export type SlackChannelList = { ok: boolean; channels: CoreChannel[]; reason?: string };

// The Slack workspace channel list feeds one <select> on the overview and the
// wizard's channel picker. It is identical for every program in a workspace,
// changes rarely, and is the slowest Core call on the overview. A short
// per-workspace window collapses repeat renders (and sibling pages) onto a
// single Core round-trip.
//
// Keyed by workspaceId, never global: one workspace's channel list can never
// be served for another. A failed fetch is deliberately not cached — it
// throws past unstable_cache, and the caller degrades to an empty list, which
// leaves the raw channel-ID field as the fallback.
async function fetchChannels(): Promise<SlackChannelList> {
  const res = await coreSlackChannels();
  if (!res.ok) throw new Error(res.reason || "slack channel list unavailable");
  return res;
}

export async function workspaceSlackChannels(workspaceId: string): Promise<SlackChannelList> {
  if (!workspaceId) return { ok: false, channels: [], reason: "no workspace" };
  try {
    return await unstable_cache(fetchChannels, ["workspace-slack-channels", workspaceId], {
      revalidate: 45,
      tags: [`slack-channels:${workspaceId}`],
    })();
  } catch (err) {
    return { ok: false, channels: [], reason: err instanceof Error ? err.message : "unavailable" };
  }
}
