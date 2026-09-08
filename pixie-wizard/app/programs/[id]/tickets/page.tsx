import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTicketSearch } from "@/lib/pixieCore";
import { PageHeader, CoreError, StatusDot, EmptyState } from "@/app/_components/DashboardShell";
import { timeAgo, userLabel } from "@/app/_components/format";

type TicketRow = {
  id: number;
  question: string;
  summary: string | null;
  status: string;
  requester_id: string;
  assignee_id: string | null;
  category: string | null;
  priority: string | null;
  created_at: number;
};

// The filter row. Not every status — the handful an operator actually
// filters by, in the order a request moves through them.
const VIEWS: Array<[value: string, label: string]> = [
  ["", "All"],
  ["open", "Unanswered"],
  ["waiting_for_helper", "Waiting"],
  ["assigned", "Assigned"],
  ["escalated", "Escalated"],
  ["resolved", "Resolved"],
];

const LIMIT = 25;

function withParams(base: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "?";
}

export default async function TicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; q?: string; assignee?: string; page?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  await requireProgramMembership(id);

  const page = Math.max(Number(query.page) || 1, 1);
  let total = 0;
  let rows: TicketRow[] = [];
  let searchError: string | null = null;
  try {
    const res = await coreTicketSearch({
      programId: id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(query.assignee ? { assigneeId: query.assignee } : {}),
      limit: String(LIMIT),
      offset: String((page - 1) * LIMIT),
    });
    total = res.total;
    rows = res.rows as TicketRow[];
  } catch (err) {
    searchError = err instanceof Error ? err.message : "Ticket search is unavailable.";
  }
  const pages = Math.max(Math.ceil(total / LIMIT), 1);
  const base = { status: query.status, q: query.q, assignee: query.assignee };

  return (
    <>
      <PageHeader title="Tickets" description="Every support request Pixie has opened for this program." />

      {/* filters — a text row, a search box, an optional assignee narrow */}
      <div className="mb-6 space-y-4">
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {VIEWS.map(([value, label]) => {
            const active = (query.status ?? "") === value;
            return (
              <Link
                key={label}
                href={withParams(base, { status: value || undefined, page: undefined })}
                aria-current={active ? "page" : undefined}
                className={`border-b-2 pb-1 transition-colors ${
                  active ? "border-brand text-text" : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                {label}
                {active && total > 0 && <span className="ml-1.5 font-mono text-xs text-text-muted">{total}</span>}
              </Link>
            );
          })}
        </nav>
        <form method="get" className="flex flex-wrap gap-2">
          {query.status && <input type="hidden" name="status" value={query.status} />}
          <input
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Search questions and summaries"
            className="min-w-0 flex-1 rounded-[var(--radius)] border border-line bg-panel-2 px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none"
          />
          <input
            name="assignee"
            defaultValue={query.assignee ?? ""}
            placeholder="Assignee ID"
            className="w-36 rounded-[var(--radius)] border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-xs text-text placeholder:text-text-muted focus:border-brand focus:outline-none"
          />
          <button type="submit" className="pixie-button pixie-button-quiet">Search</button>
        </form>
      </div>

      {searchError ? (
        <CoreError message={searchError} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No tickets in this view."
          hint="Questions in the help channel open tickets automatically when they need a person."
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((t) => (
            <li key={t.id}>
              <Link href={`/programs/${id}/tickets/${t.id}`} className="group grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text group-hover:text-brand">
                    <span className="font-mono text-xs text-text-muted">#{t.id}</span> {t.summary || t.question}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-text-muted">
                    {userLabel(t.requester_id)}
                    {t.category ? ` · ${t.category}` : ""}
                    {t.priority && t.priority !== "normal" ? ` · ${t.priority}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-0.5">
                  <StatusDot status={t.status}>{t.status.replace(/_/g, " ")}</StatusDot>
                  <span className="font-mono text-xs text-text-muted">
                    {t.assignee_id ? `${userLabel(t.assignee_id)} · ` : ""}
                    {timeAgo(t.created_at)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="mt-6 flex items-center gap-5 text-sm text-text-muted">
          <span className="font-mono text-xs">
            {page} / {pages}
          </span>
          {page > 1 && (
            <Link href={withParams(base, { page: String(page - 1) })} className="hover:text-text">
              ← Newer
            </Link>
          )}
          {page < pages && (
            <Link href={withParams(base, { page: String(page + 1) })} className="hover:text-text">
              Older →
            </Link>
          )}
        </div>
      )}
    </>
  );
}
