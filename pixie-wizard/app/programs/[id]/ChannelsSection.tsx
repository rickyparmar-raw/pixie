import { listHostedChannels } from "@/lib/hostedPrograms";
import { workspaceSlackChannels } from "@/lib/coreChannels";
import { ChannelChangeForm } from "./ChannelChangeForm";
import { SectionCard } from "@/app/_components/DashboardShell";

// Streamed in its own Suspense boundary on the overview: the workspace
// channel list is the slowest Core call on the page and nothing above it
// depends on the result. Both reads fail soft — a slow or unreachable Core
// still renders the claimed-channel list and the raw channel-ID fallback.
export async function ChannelsSection({ programId, workspaceId }: { programId: string; workspaceId: string }) {
  const [claimed, list] = await Promise.all([
    listHostedChannels(programId).catch(() => []),
    workspaceSlackChannels(workspaceId),
  ]);

  return (
    <SectionCard title="Channels" description="Claimed support and organizer channels.">
      <ul className="mt-3 space-y-1 text-sm text-text">
        {claimed.map((c) => (
          <li key={`${c.workspace_id}:${c.channel_id}`} className="font-mono">
            &lt;#{c.channel_id}&gt; <span className="font-sans text-text-muted">· {c.kind}</span>
          </li>
        ))}
        {claimed.length === 0 && <li className="text-text-muted">No channels claimed yet.</li>}
      </ul>
      <ChannelChangeForm programId={programId} channels={list.channels} />
    </SectionCard>
  );
}
