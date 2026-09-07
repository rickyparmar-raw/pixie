import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { coreRetentionPreview } from "@/lib/pixieCore";
import { RetentionPolicyForm, RetentionSweepForm } from "./RetentionForms";

export default async function RetentionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  let preview: Record<string, unknown> | null = null;
  let loadError: string | null = null;
  try {
    preview = await coreRetentionPreview(id);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load retention preview.";
  }

  const policy = (preview?.policy ?? {}) as Record<string, number>;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · retention</p>
      <h1 className="font-heading mt-3 text-2xl text-text">What gets forgotten</h1>
      <p className="mt-2 text-sm text-text-muted">Raw support content expires on schedule. Approved knowledge and open tickets survive.</p>

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      {preview && (
        <div className="mt-6 rounded-lg border border-line bg-panel p-6">
          <h2 className="font-heading text-lg text-text">Currently eligible for deletion</h2>
          <ul className="mt-3 space-y-1 text-sm text-text">
            <li>Tickets <span className="text-text-muted">· {String(preview.tickets ?? 0)}</span></li>
            <li>Timeline events <span className="text-text-muted">· {String(preview.ticketEvents ?? 0)}</span></li>
            <li>Notes <span className="text-text-muted">· {String(preview.notes ?? 0)}</span></li>
            <li>Metrics <span className="text-text-muted">· {String(preview.metrics ?? 0)}</span></li>
            <li>Doc gaps <span className="text-text-muted">· {String(preview.gaps ?? 0)}</span></li>
          </ul>
        </div>
      )}

      <div className="mt-6">
        <RetentionPolicyForm programId={id} policy={policy} />
      </div>
      <div className="mt-6">
        <RetentionSweepForm programId={id} />
      </div>

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back</Link>
    </main>
  );
}
