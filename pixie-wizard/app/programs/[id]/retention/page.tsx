import type { ReactNode } from "react";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreRetentionPreview } from "@/lib/pixieCore";
import { PageHeader, Section, StatCard, CoreError } from "@/app/_components/DashboardShell";
import { IconChat, IconClock, IconDoc, IconBars, IconGaps } from "@/app/_components/icons";
import { RetentionPolicyForm, RetentionSweepForm } from "./RetentionForms";

export default async function RetentionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  let preview: Record<string, unknown> | null = null;
  let loadError: string | null = null;
  try {
    preview = await coreRetentionPreview(id);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load retention preview.";
  }

  const policy = (preview?.policy ?? {}) as Record<string, number>;
  // What a sweep would delete right now, one figure per content type. Keys and
  // labels come straight off the Core preview; nothing here is estimated.
  const eligible: Array<[string, string, ReactNode]> = preview
    ? [
        ["Tickets", String(preview.tickets ?? 0), <IconChat key="i" size={16} />],
        ["Timeline events", String(preview.ticketEvents ?? 0), <IconClock key="i" size={16} />],
        ["Notes", String(preview.notes ?? 0), <IconDoc key="i" size={16} />],
        ["Metrics", String(preview.metrics ?? 0), <IconBars key="i" size={16} />],
        ["Doc gaps", String(preview.gaps ?? 0), <IconGaps key="i" size={16} />],
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Retention"
        description="Raw support content expires on schedule. Approved knowledge and open tickets are kept."
      />

      {loadError && <CoreError message={loadError} />}

      <div className="space-y-8">
        {preview && (
          <Section title="Eligible for deletion now">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {eligible.map(([label, value, icon]) => (
                <StatCard key={label} label={label} value={value} icon={icon} />
              ))}
            </div>
          </Section>
        )}

        <RetentionPolicyForm programId={id} policy={policy} />
        <RetentionSweepForm programId={id} />
      </div>
    </>
  );
}
