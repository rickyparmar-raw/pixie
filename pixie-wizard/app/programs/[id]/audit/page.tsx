import { requireProgramMembership } from "@/lib/programAccess";
import { coreAudit } from "@/lib/pixieCore";
import { PageHeader, CoreError, EmptyState } from "@/app/_components/DashboardShell";
import { shortTime, userLabel } from "@/app/_components/format";

type AuditEvent = {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: string | null;
  created_at: number;
};

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
    loadError = err instanceof Error ? err.message : "The audit log is unavailable.";
  }

  const needle = (query.q ?? "").toLowerCase().trim();
  const rows = (needle
    ? events.filter((e) =>
        `${e.action} ${e.actor_id ?? ""} ${e.entity_type ?? ""} ${e.entity_id ?? ""}`.toLowerCase().includes(needle),
      )
    : events
  )
    .slice()
    .sort((a, b) => b.created_at - a.created_at);

  return (
    <>
      <PageHeader title="Audit log" description="Append-only. Every state change, no secrets." />

      <form method="get" className="mb-6 flex gap-2">
        <input
          name="q"
          defaultValue={query.q ?? ""}
          placeholder="Filter by actor, action or entity"
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-line bg-panel-2 px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none"
        />
        <button type="submit" className="pixie-button pixie-button-quiet">Filter</button>
      </form>

      {loadError ? (
        <CoreError message={loadError} />
      ) : rows.length === 0 ? (
        <EmptyState title={needle ? "Nothing matches that filter." : "No audit events yet."} />
      ) : (
        <ul className="divide-y divide-line border-y border-line font-mono text-xs">
          {rows.map((e) => (
            <li key={e.id} className="grid grid-cols-[4.5rem_1fr] gap-x-3 py-2 sm:grid-cols-[9rem_7rem_1fr]">
              <span className="text-text-muted">{shortTime(e.created_at)}</span>
              <span className="truncate text-text-muted">{e.actor_id ? userLabel(e.actor_id) : "pixie"}</span>
              <span className="col-span-2 truncate text-text sm:col-span-1">
                {e.action}
                {e.entity_type ? (
                  <span className="text-text-muted">
                    {" "}
                    {e.entity_type}
                    {e.entity_id ? ` ${e.entity_type === "ticket" ? "#" : ""}${e.entity_id}` : ""}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
