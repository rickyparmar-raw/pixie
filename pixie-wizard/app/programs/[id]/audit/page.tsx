import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { coreAudit } from "@/lib/pixieCore";

interface AuditEvent {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: string | null;
  created_at: number;
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  let events: AuditEvent[] = [];
  let loadError: string | null = null;
  try {
    events = (await coreAudit(id)) as AuditEvent[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load audit events.";
  }

  const needle = (query.q ?? "").toLowerCase();
  const filtered = needle
    ? events.filter((e) => `${e.action} ${e.actor_id ?? ""} ${e.entity_type ?? ""} ${e.entity_id ?? ""}`.toLowerCase().includes(needle))
    : events;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · audit</p>
      <h1 className="font-heading mt-3 text-2xl text-text">What happened</h1>
      <p className="mt-2 text-sm text-text-muted">Append-only. Secrets are never recorded here.</p>

      <form method="get" className="mt-6 flex gap-2">
        <input name="q" defaultValue={query.q ?? ""} placeholder="Filter by actor, action, entity…" className="w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none" />
        <button type="submit" className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">Go</button>
      </form>

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      <ul className="mt-6 space-y-2 text-sm">
        {filtered.map((e) => (
          <li key={e.id} className="rounded-md border border-line bg-panel p-3">
            <span className="text-text">{e.action}</span>
            <span className="text-text-muted">{e.actor_id ? ` by <@${e.actor_id}>` : ""}{e.entity_type ? ` · ${e.entity_type}${e.entity_id ? ` #${e.entity_id}` : ""}` : ""} · {new Date(e.created_at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      {filtered.length === 0 && !loadError && <p className="mt-6 text-sm text-text-muted">No audit events yet.</p>}

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back</Link>
    </main>
  );
}
