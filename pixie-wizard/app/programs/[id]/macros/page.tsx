import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { coreMacrosList } from "@/lib/pixieCore";
import { MacroCreateForm, MacroRowCard, type MacroRow } from "./MacroForms";

export default async function MacrosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  let macros: MacroRow[] = [];
  let loadError: string | null = null;
  try {
    macros = (await coreMacrosList(id)) as MacroRow[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load macros.";
  }

  return (
    <main className="max-w-none px-0 py-0">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · macros</p>
      <h1 className="font-heading mt-3 text-2xl text-text">Approved replies</h1>
      <p className="mt-2 text-sm text-text-muted">Helpers send these from any ticket. <code>{"{requester} {ticket_id} {program} {status} {helper}"}</code> interpolate; anything else stays literal.</p>

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      <div className="mt-6">
        <MacroCreateForm programId={id} />
      </div>

      <div className="mt-6 space-y-4">
        {macros.map((m) => (
          <MacroRowCard key={m.id} programId={id} macro={m} />
        ))}
      </div>
      {macros.length === 0 && !loadError && <p className="mt-6 text-sm text-text-muted">No macros yet. The first one is usually ?shipping.</p>}

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back</Link>
    </main>
  );
}
