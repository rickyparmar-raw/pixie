import { Suspense } from "react";
import { requireProgramMembership } from "@/lib/programAccess";
import { PageHeader, Section } from "@/app/_components/DashboardShell";
import { ProgramSettingsForms } from "../ProgramSettingsForms";
import { ChannelsSection } from "../ChannelsSection";
import { LaunchSection } from "./LaunchSection";
import { HistoryImportCard } from "./HistoryImportCard";
import { coreHistoryImportProgress, type CoreHistoryImportProgress } from "@/lib/pixieCore";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program, relationship } = await requireProgramMembership(id);
  let historyProgress: CoreHistoryImportProgress | null = null;
  let historyError: string | null = null;
  try {
    historyProgress = await coreHistoryImportProgress(id);
  } catch (err) {
    historyError = err instanceof Error ? err.message : "Could not load history import progress.";
  }

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
        <HistoryImportCard
          programId={id}
          progress={historyProgress}
          loadError={historyError}
          canRun={relationship === "owner" || relationship === "admin"}
        />
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
