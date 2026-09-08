import { requireProgramMembership } from "@/lib/programAccess";
import { coreAudit } from "@/lib/pixieCore";
import { PageHeader, CoreError } from "@/app/_components/DashboardShell";

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
  await requireProgramMembership(id);

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
    <>
      <PageHeader title="Audit log" description="Append-only. Secrets are never recorded." />

      <form method="get" className="mb-8 flex gap-2">
        <input
          name="q"
          defaultValue={query.q ?? ""}
          placeholder="Filter by actor, action or entity"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none"
        />
        <button type="submit" className="pixie-button pixie-button-primary">Filter</button>
      </form>

      {loadError && <CoreError message={loadError} />}

      <ul className="divide-y divide-line border-t border-line text-sm">
        {filtered.map((e) => (
          <li key={e.id} className="py-2.5">
            <span className="text-text">{e.action}</span>
            <span className="text-text-muted">
              {e.actor_id ? ` by <@${e.actor_id}>` : ""}
              {e.entity_type ? ` · ${e.entity_type}${e.entity_id ? ` #${e.entity_id}` : ""}` : ""}
              {" · "}
              {new Date(e.created_at).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
      {filtered.length === 0 && !loadError && <p className="text-sm text-text-muted">No audit events yet.</p>}
    </>
  );
}
