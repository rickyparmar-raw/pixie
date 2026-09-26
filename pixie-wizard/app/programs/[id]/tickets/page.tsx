import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTicketSearch } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, CoreError, StatusBadge, Chip, EmptyState, Mono } from "@/app/_components/DashboardShell";
import { IconSearch, IconChevronRight } from "@/app/_components/icons";
import { timeAgo } from "@/app/_components/format";
import { TicketResolveButton } from "./TicketResolveButton";

const RESOLVABLE_STATUSES = new Set(["open", "waiting_for_helper", "assigned", "escalated", "reopened", "claimed"]);

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

// A status is operational text, so it reads in mono with a square marker in its
// tone: mint resolved, tang waiting, danger failed. `urgent` is the one
// priority that is a problem rather than a hint.
function priorityTone(priority: string): string {
  if (priority === "urgent") return "text-danger";
  if (priority === "high") return "text-tang";
  return "";
}

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
  const identities = await resolveIdentities(rows.flatMap((t) => [t.requester_id, t.assignee_id]));

  const firstShown = rows.length === 0 ? 0 : (page - 1) * LIMIT + 1;
  const lastShown = (page - 1) * LIMIT + rows.length;

  return (
    <>
      <PageHeader title="Tickets" description="Every support request Pixie has opened for this program." />

      {/* views — the statuses a helper actually filters by, then a search row */}
      <div className="mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <nav aria-label="Ticket views" className="flex flex-wrap items-center gap-1.5">
            {VIEWS.map(([value, label]) => {
              const active = (query.status ?? "") === value;
              return (
                <Link
                  key={label}
                  href={withParams(base, { status: value || undefined, page: undefined })}
                  aria-current={active ? "page" : undefined}
                  className={`pixie-button pixie-button-sm ${
                    active
                      ? "bg-brand/15 text-text"
                      : "pixie-button-ghost text-text-muted hover:text-text"
                  }`}
                >
                  {label}
                  {active && total > 0 && <span className="font-mono text-[12px] text-brand">{total}</span>}
                </Link>
              );
            })}
          </nav>
          {!searchError && rows.length > 0 && (
            <p className="ml-auto font-mono text-[12px] text-text-muted">
              {firstShown}–{lastShown} of {total}
            </p>
          )}
        </div>

        <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {query.status && <input type="hidden" name="status" value={query.status} />}
          <div className="relative min-w-0 flex-1">
            <IconSearch
              size={16}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Search questions and summaries"
              aria-label="Search questions and summaries"
              className="pixie-input pl-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              name="assignee"
              defaultValue={query.assignee ?? ""}
              placeholder="Assignee ID"
              aria-label="Filter by assignee Slack user ID"
              className="pixie-input min-w-0 flex-1 font-mono text-xs sm:w-40 sm:flex-none"
            />
            <button type="submit" className="pixie-button pixie-button-quiet">Search</button>
          </div>
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
          {rows.map((t) => {
            const priority = t.priority && t.priority !== "normal" ? t.priority : null;
            return (
              <li key={t.id} className="group">
                <div className="-mx-2.5 flex flex-col gap-2.5 rounded-[3px] px-2.5 py-2.5 transition-colors group-hover:bg-panel-2 sm:flex-row sm:items-center sm:gap-6">
                  <Link href={`/programs/${id}/tickets/${t.id}`} className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2.5">
                      <span className="shrink-0 font-mono text-[12px] text-text-muted">#{t.id}</span>
                      <span className="min-w-0 truncate text-sm text-text transition-colors group-hover:text-brand">
                        {t.summary || t.question}
                      </span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-muted">
                      <span>{labelFor(identities, t.requester_id)}</span>
                      {t.category ? <Chip>{t.category}</Chip> : null}
                      {priority ? <span className={`pixie-chip ${priorityTone(priority)}`}>{priority}</span> : null}
                    </span>
                  </Link>
                  <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 sm:min-w-[17rem] sm:flex-nowrap sm:justify-end">
                    <StatusBadge status={t.status.replace(/_/g, " ")} />
                    <span className="text-[12px] text-text-muted">
                      {t.assignee_id ? `${labelFor(identities, t.assignee_id)} · ` : ""}
                      <Mono>{timeAgo(t.created_at)}</Mono>
                    </span>
                    {RESOLVABLE_STATUSES.has(t.status) && (
                      <TicketResolveButton programId={id} ticketId={t.id} />
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Ticket pages" className="mt-5 flex items-center gap-2">
          <span className="mr-auto font-mono text-[12px] text-text-muted">
            page {page} / {pages}
          </span>
          {page > 1 && (
            <Link
              href={withParams(base, { page: String(page - 1) })}
              className="pixie-button pixie-button-quiet pixie-button-sm"
            >
              <IconChevronRight size={16} className="rotate-180" /> Newer
            </Link>
          )}
          {page < pages && (
            <Link href={withParams(base, { page: String(page + 1) })} className="pixie-button pixie-button-quiet pixie-button-sm">
              Older <IconChevronRight size={16} />
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
