import { requireProgramMembership } from "@/lib/programAccess";
import { coreMacrosList } from "@/lib/pixieCore";
import { PageHeader, CoreError } from "@/app/_components/DashboardShell";
import { MacroCreateForm, MacroRowCard, type MacroRow } from "./MacroForms";

export default async function MacrosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  let macros: MacroRow[] = [];
  let loadError: string | null = null;
  try {
    macros = (await coreMacrosList(id)) as MacroRow[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load macros.";
  }

  return (
    <>
      <PageHeader
        title="Macros"
        description="Saved replies helpers can send from any ticket. {requester} {ticket_id} {program} {status} {helper} interpolate."
      />

      {loadError && <CoreError message={loadError} />}

      <MacroCreateForm programId={id} />

      <div className="mt-8 space-y-4">
        {macros.map((m) => (
          <MacroRowCard key={m.id} programId={id} macro={m} />
        ))}
      </div>
      {macros.length === 0 && !loadError && <p className="mt-8 text-sm text-text-muted">No macros yet.</p>}
    </>
  );
}
