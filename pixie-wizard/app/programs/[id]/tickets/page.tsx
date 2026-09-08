import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTicketSearch } from "@/lib/pixieCore";
import { PageHeader, CoreError } from "@/app/_components/DashboardShell";

interface TicketRow {
  id: number;
  question: string;
  status: string;
  requester_id: string;
  assignee_id: string | null;
  category: string | null;
  priority: string | null;
  created_at: number;
}

const STATUSES = ["open", "ai_answered", "waiting_for_helper", "assigned", "escalated", "resolved", "reopened", "closed", "snoozed", "duplicate"];

function pageHref(query: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v) params.set(k, v);
  }
  params.set("page", String(page));
  return `?${params.toString()}`;
}

export default async function TicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; q?: string; assignee?: string; requester?: string; category?: string; priority?: string; page?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  await requireProgramMembership(id);

  const page = Math.max(Number(query.page) || 1, 1);
  const limit = 20;
  let total = 0;
  let rows: TicketRow[] = [];
  let searchError: string | null = null;
  try {
    const res = await coreTicketSearch({
      programId: id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { q: query.q } : {}),
      ...(query.assignee ? { assigneeId: query.assignee } : {}),
      ...(query.requester ? { requesterId: query.requester } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      limit: String(limit),
      offset: String((page - 1) * limit),
    });
    total = res.total;
    rows = res.rows as TicketRow[];
  } catch (err) {
    searchError = err instanceof Error ? err.message : "Search failed.";
  }
  const pages = Math.max(Math.ceil(total / limit), 1);

  return (
    <>
      <PageHeader
        title="Support queue"
        description={total > 0 ? `${total} ticket${total === 1 ? "" : "s"} match this view.` : undefined}
      />

      <form method="get" className="mb-8 space-y-2">
        <div className="flex flex-wrap gap-2">
          <input name="q" defaultValue={query.q ?? ""} placeholder="Search questions" className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none" />
          <select name="status" defaultValue={query.status ?? ""} className="rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text focus:border-brand focus:outline-none">
            <option value="">All states</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button type="submit" className="pixie-button pixie-button-primary">Search</button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <input name="assignee" defaultValue={query.assignee ?? ""} placeholder="Assignee ID" className="w-32 rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-text placeholder:text-text-muted focus:border-brand focus:outline-none" />
          <input name="requester" defaultValue={query.requester ?? ""} placeholder="Requester ID" className="w-32 rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-text placeholder:text-text-muted focus:border-brand focus:outline-none" />
          <input name="category" defaultValue={query.category ?? ""} placeholder="Category" className="w-28 rounded-md border border-line bg-panel-2 px-2 py-1 text-text placeholder:text-text-muted focus:border-brand focus:outline-none" />
          <input name="priority" defaultValue={query.priority ?? ""} placeholder="Priority" className="w-24 rounded-md border border-line bg-panel-2 px-2 py-1 text-text placeholder:text-text-muted focus:border-brand focus:outline-none" />
        </div>
      </form>

      {searchError && <CoreError message={searchError} />}

      <ul className="divide-y divide-line border-t border-line">
        {rows.map((t) => (
          <li key={t.id} className="py-3">
            <Link href={`/programs/${id}/tickets/${t.id}`} className="group block">
              <p className="text-xs text-text-muted">
                #{t.id} · {t.status}
              </p>
              <p className="mt-0.5 text-sm text-text group-hover:text-brand">{t.question}</p>
              <p className="mt-0.5 text-xs text-text-muted">
                &lt;@{t.requester_id}&gt;
                {t.assignee_id && <> · claimed by &lt;@{t.assignee_id}&gt;</>}
                {t.category && <> · {t.category}</>}
                {t.priority && <> · {t.priority}</>}
              </p>
            </Link>
          </li>
        ))}
      </ul>
      {rows.length === 0 && !searchError && (
        <p className="text-sm text-text-muted">No tickets in this view. New help-channel questions appear automatically.</p>
      )}

      {pages > 1 && (
        <div className="mt-6 flex items-center gap-4 text-sm text-text-muted">
          <span>Page {page} of {pages}</span>
          {page > 1 && <Link href={pageHref(query, page - 1)} className="hover:text-text">← Prev</Link>}
          {page < pages && <Link href={pageHref(query, page + 1)} className="hover:text-text">Next →</Link>}
        </div>
      )}
    </>
  );
}
