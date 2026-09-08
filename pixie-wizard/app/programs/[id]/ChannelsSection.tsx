import { listHostedChannels } from "@/lib/hostedPrograms";
import { workspaceSlackChannels } from "@/lib/coreChannels";
import { ChannelChangeForm } from "./ChannelChangeForm";
import { Section } from "@/app/_components/DashboardShell";

// Streamed in its own Suspense boundary: the workspace channel list is the
// slowest Core call on the settings page and nothing else depends on it.
// Both reads fail soft — a slow or unreachable Core still renders the
// claimed-channel list and the raw channel-ID fallback field.
export async function ChannelsSection({ programId, workspaceId }: { programId: string; workspaceId: string }) {
  const [claimed, list] = await Promise.all([
    listHostedChannels(programId).catch(() => []),
    workspaceSlackChannels(workspaceId),
  ]);

  return (
    <Section title="Channels" description="Claimed help and organizer channels.">
      <ul className="space-y-1.5 text-sm">
        {claimed.map((c) => (
          <li key={`${c.workspace_id}:${c.channel_id}`} className="text-text">
            <span className="font-mono text-text-muted">#</span>
            {c.channel_id}
            <span className="ml-2 text-text-muted">{c.kind}</span>
          </li>
        ))}
        {claimed.length === 0 && <li className="text-text-muted">No channels claimed yet.</li>}
      </ul>
      <ChannelChangeForm programId={programId} channels={list.channels} />
    </Section>
  );
}
