import { requireProgramMembership } from "@/lib/programAccess";
import { coreRetentionPreview } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";
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
  const eligible: Array<[string, string]> = preview
    ? [
        ["Tickets", String(preview.tickets ?? 0)],
        ["Timeline events", String(preview.ticketEvents ?? 0)],
        ["Notes", String(preview.notes ?? 0)],
        ["Metrics", String(preview.metrics ?? 0)],
        ["Doc gaps", String(preview.gaps ?? 0)],
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Retention"
        description="Raw support content expires on schedule. Approved knowledge and open tickets are kept."
      />

      {loadError && <CoreError message={loadError} />}

      <div className="space-y-12">
        {preview && (
          <Section title="Eligible for deletion now">
            <ul className="max-w-sm">
              {eligible.map(([label, value]) => (
                <li key={label} className="flex justify-between gap-4 py-1 text-sm">
                  <span className="text-text-muted">{label}</span>
                  <span className="tabular-nums text-text">{value}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <RetentionPolicyForm programId={id} policy={policy} />
        <RetentionSweepForm programId={id} />
      </div>
    </>
  );
}
