import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreAudit } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, Section, CoreError, EmptyState } from "@/app/_components/DashboardShell";
import { shortTime } from "@/app/_components/format";
import { inputClass } from "@/app/wizard/_components/formStyles";
import { IconSearch, IconExit } from "@/app/_components/icons";

type AuditEvent = {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: string | null;
  created_at: number;
};

// "ticket #4128", "program pixl", "macro 33" — the entity a ledger row points
// at, in the shape the action implies.
function entityLabel(e: AuditEvent): string {
  if (!e.entity_type) return "";
  return `${e.entity_type}${e.entity_id ? ` ${e.entity_type === "ticket" ? "#" : ""}${e.entity_id}` : ""}`;
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

  const identities = await resolveIdentities(rows.map((e) => e.actor_id));

  return (
    <>
      <PageHeader title="Audit log" description="Append-only. Every state change, no secrets." />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <form method="get" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <label className="relative block min-w-0 flex-1">
            <span className="sr-only">Filter the audit log</span>
            <IconSearch
              size={16}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Filter by actor, action or entity"
              className={`${inputClass} pl-9`}
            />
          </label>
          <button type="submit" className="pixie-button pixie-button-quiet">
            <IconSearch size={16} />
            Filter
          </button>
        </form>
        {/* A sibling of the form, never inside it: clearing is a navigation, not
            another way to submit the filter. */}
        {needle && (
          <Link href={`/programs/${id}/audit`} className="pixie-button pixie-button-ghost">
            <IconExit size={16} />
            Clear
          </Link>
        )}
      </div>

      {loadError ? (
        <CoreError message={loadError} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={needle ? "Nothing matches that filter." : "No audit events yet."}
          hint={
            needle
              ? "Try a shorter filter, or clear it to read the whole log."
              : "Every state change in this program lands here as it happens."
          }
        />
      ) : (
        <Section
          title="Events"
          bordered
          actions={
            <span className="font-mono text-xs tabular-nums text-text-muted">
              {needle ? `${rows.length} of ${events.length}` : rows.length}
            </span>
          }
        >
          {/* Four columns on a ledger row. Below the sm breakpoint the row
              stacks into two lines (actor, then time + action + entity) so the
              log stays readable on a phone without a side scroll. */}
          <table className="pixie-table">
            <thead className="hidden sm:table-header-group">
              <tr>
                <th className="w-[6.5rem]">Time</th>
                <th className="w-[13.5rem]">Actor</th>
                <th>Action</th>
                <th className="w-[13rem]">Entity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="block last:[&>td]:border-b-0 sm:table-row">
                  <td className="hidden w-[6.5rem] whitespace-nowrap font-mono text-xs tabular-nums text-text-muted sm:table-cell">
                    {shortTime(e.created_at)}
                  </td>
                  <td className="block border-b-0 py-1 sm:table-cell sm:border-b sm:py-2.5">
                    <span className="text-text-muted">
                      {e.actor_id ? labelFor(identities, e.actor_id) : "pixie"}
                    </span>
                    {e.actor_id && identities.get(e.actor_id)?.label !== `@${e.actor_id}` && (
                      <span className="ml-1.5 font-mono text-[11px] text-text-muted/60">{e.actor_id}</span>
                    )}
                  </td>
                  <td className="block border-b py-1.5 font-mono text-xs text-text sm:table-cell sm:border-b sm:py-2.5">
                    <span className="tabular-nums text-text-muted sm:hidden">{shortTime(e.created_at)} · </span>
                    <span className="break-words">{e.action}</span>
                    {e.entity_type && <span className="text-text-muted sm:hidden"> {entityLabel(e)}</span>}
                  </td>
                  <td className="hidden font-mono text-xs text-text-muted sm:table-cell sm:border-b">
                    {e.entity_type ? entityLabel(e) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}
