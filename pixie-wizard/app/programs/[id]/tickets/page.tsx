import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTicketSearch } from "@/lib/pixieCore";

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
  const { program } = await requireProgramMembership(id);

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
    <main className="max-w-none px-0 py-0">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · tickets</p>
      <h1 className="font-heading mt-3 text-2xl text-text">Support queue {total > 0 && <span className="text-text-muted">({total})</span>}</h1>

      <form method="get" className="mt-6 space-y-2">
        <div className="flex gap-2">
          <input name="q" defaultValue={query.q ?? ""} placeholder="Search questions…" className="w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none" />
          <select name="status" defaultValue={query.status ?? ""} className="rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text">
            <option value="">All states</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button type="submit" className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">Go</button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <input name="assignee" defaultValue={query.assignee ?? ""} placeholder="Assignee ID" className="w-32 rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-text" />
          <input name="requester" defaultValue={query.requester ?? ""} placeholder="Requester ID" className="w-32 rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-text" />
          <input name="category" defaultValue={query.category ?? ""} placeholder="Category" className="w-28 rounded-md border border-line bg-panel-2 px-2 py-1 text-text" />
          <input name="priority" defaultValue={query.priority ?? ""} placeholder="Priority" className="w-24 rounded-md border border-line bg-panel-2 px-2 py-1 text-text" />
        </div>
      </form>

      {searchError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{searchError} — is Pixie Core running?</p>}

      <ul className="mt-6 space-y-3">
        {rows.map((t) => (
          <li key={t.id} className="rounded-lg border border-line bg-panel p-4">
            <Link href={`/programs/${id}/tickets/${t.id}`} className="text-sm text-text hover:underline">
              <span className="font-heading text-xs text-text-muted">#{t.id} · {t.status}</span>
              <span className="mt-1 block">{t.question}</span>
            </Link>
            <p className="mt-1 text-xs text-text-muted">
              <span>&lt;@{t.requester_id}&gt;</span>
              {t.assignee_id && <span> · claimed by &lt;@{t.assignee_id}&gt;</span>}
              {t.category && <span> · {t.category}</span>}
              {t.priority && <span> · {t.priority}</span>}
            </p>
          </li>
        ))}
      </ul>
      {rows.length === 0 && !searchError && <p className="mt-6 text-sm text-text-muted">No tickets here yet. New help-channel questions show up automatically.</p>}

      {pages > 1 && (
        <div className="mt-6 flex items-center gap-3 text-sm text-text-muted">
          <span>Page {page} of {pages}</span>
          {page > 1 && <Link href={pageHref(query, page - 1)} className="underline">← Prev</Link>}
          {page < pages && <Link href={pageHref(query, page + 1)} className="underline">Next →</Link>}
        </div>
      )}

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back to {program.program_name}</Link>
    </main>
  );
}
