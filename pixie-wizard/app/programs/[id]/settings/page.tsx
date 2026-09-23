import { Suspense } from "react";
import { requireProgramMembership } from "@/lib/programAccess";
import { PageHeader, Section } from "@/app/_components/DashboardShell";
import { ProgramSettingsForms } from "../ProgramSettingsForms";
import { ChannelsSection } from "../ChannelsSection";
import { LaunchSection } from "./LaunchSection";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program, relationship } = await requireProgramMembership(id);

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
        {relationship === "owner" || relationship === "admin" ? (
          <ProgramSettingsForms program={program} />
        ) : (
          <Section title="Behavior" description="Helpers and viewers can read settings but not change them.">
            <p className="text-sm text-text-muted">Only the program owner or an organizer can edit these settings.</p>
          </Section>
        )}
        {(relationship === "owner" || relationship === "admin") && (
          <LaunchSection programId={id} runtimeStatus={program.runtime_status} />
        )}
      </div>
    </>
  );
}
