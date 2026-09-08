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
      <PageHeader title="Settings" description="Behavior, knowledge sources and channels for this program." />
      <div className="space-y-12">
        <Suspense
          fallback={
            <Section title="Channels" description="Claimed help and organizer channels.">
              <p className="text-sm text-text-muted">Loading channels…</p>
            </Section>
          }
        >
          <ChannelsSection programId={id} workspaceId={program.workspace_id} />
        </Suspense>
        <ProgramSettingsForms program={program} />
      </div>
    </>
  );
}
