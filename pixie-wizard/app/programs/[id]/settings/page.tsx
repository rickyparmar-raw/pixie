import { Suspense } from "react";
import { requireProgramMembership } from "@/lib/programAccess";
import { PageHeader, Section } from "@/app/_components/DashboardShell";
import { ProgramSettingsForms } from "../ProgramSettingsForms";
import { ChannelsSection } from "../ChannelsSection";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program } = await requireProgramMembership(id);

  return (
    <>
      <PageHeader
        title="Settings"
        description="How Pixie behaves here, what she reads, and where she answers."
      />
      <div className="max-w-4xl space-y-8">
        <Suspense fallback={<ChannelsPlaceholder />}>
          <ChannelsSection programId={id} workspaceId={program.workspace_id} />
        </Suspense>
        <ProgramSettingsForms program={program} />
      </div>
    </>
  );
}

// The streamed boundary keeps the section's own title and description so the
// page doesn't jump when the channel list lands — only the body is a skeleton.
function ChannelsPlaceholder() {
  return (
    <Section bordered title="Channels" description="Where Pixie answers, and where work lands for your helpers.">
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading channels">
        <div className="pixie-skeleton h-4 w-56 max-w-full" />
        <div className="pixie-skeleton h-9 w-full max-w-md" />
        <div className="pixie-skeleton h-9 w-full max-w-md" />
        <span className="sr-only">Loading channels.</span>
      </div>
    </Section>
  );
}
