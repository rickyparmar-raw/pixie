import Link from "next/link";

export const programNav = [
  ["", "Overview"], ["tickets", "Tickets"], ["knowledge", "Knowledge"],
  ["gaps", "FAQ Gaps"], ["helpers", "Helpers"], ["macros", "Macros"],
  ["analytics", "Analytics"], ["incidents", "Incidents"], ["audit", "Audit"],
];

export function DashboardShell({ children, programId, programName }: { children: React.ReactNode; programId?: string; programName?: string }) {
  const overviewHref = programId ? `/programs/${programId}` : "/overview";
  return <div className="min-h-screen bg-ink text-text"><aside className="fixed inset-y-0 left-0 z-10 hidden w-[226px] border-r border-line bg-ink px-4 py-5 lg:block"><Link href="/overview" className="flex items-center gap-2 px-2 text-sm font-medium"><span className="grid size-7 place-items-center rounded-full bg-brand text-ink">✦</span>pixie</Link><p className="mt-9 px-2 text-[10px] uppercase tracking-[0.18em] text-text-muted">Workspace</p><Link href="/overview" className="mt-3 block rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-xs text-text">Overview</Link><Link href="/programs" className="mt-1 block px-3 py-2 text-xs text-text-muted hover:text-text">Programs</Link>{programId && <><div className="my-5 border-t border-line" /><div className="flex items-center gap-2 px-2 text-xs"><span className="grid size-7 place-items-center rounded-md bg-brand/70 text-[10px] text-ink">{programName?.slice(0,2).toUpperCase()}</span><span className="truncate">{programName}</span></div><p className="mt-6 px-2 text-[10px] uppercase tracking-[0.18em] text-text-muted">Program support</p><nav className="mt-2 space-y-0.5">{programNav.map(([slug,label]) => <Link key={label} href={`/programs/${programId}/${slug}`} className="block rounded-md px-3 py-2 text-xs text-text-muted hover:bg-panel hover:text-text">{label}</Link>)}<Link href={`/programs/${programId}`} className="block rounded-md px-3 py-2 text-xs text-text-muted hover:bg-panel hover:text-text">Settings</Link></nav></>}</aside><div className="lg:pl-[226px]"><header className="flex min-h-[70px] flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4 lg:px-8"><div className="text-xs text-text-muted"><span className="text-text">pixie</span> <span className="px-2">/</span>{programName ?? "Overview"}</div><Link href="/wizard?mode=hosted" className="text-xs text-text-muted hover:text-text">New program ›</Link>{programId && <nav className="flex w-full gap-1 overflow-x-auto pb-1 lg:hidden">{programNav.map(([slug,label]) => <Link key={label} href={`/programs/${programId}/${slug}`} className="whitespace-nowrap rounded-md border border-line px-2 py-1 text-[10px] text-text-muted">{label}</Link>)}</nav>}</header><main className="mx-auto max-w-[1180px] px-6 py-8 lg:px-8">{children}</main></div></div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: React.ReactNode }) {
  return <div className="mb-7 flex items-start justify-between gap-5"><div>{eyebrow && <p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">{eyebrow}</p>}<h1 className="mt-2 text-2xl font-medium text-text">{title}</h1>{description && <p className="mt-2 text-sm text-text-muted">{description}</p>}</div>{actions && <div className="shrink-0">{actions}</div>}</div>;
}

export function SectionCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <section className="pixie-panel overflow-hidden"><div className="border-b border-line px-5 py-4"><h2 className="text-sm text-text">{title}</h2>{description && <p className="mt-1 text-xs text-text-muted">{description}</p>}</div><div className="p-5">{children}</div></section>;
}

export function MetricCard({ label, value, detail, tone = "text-mint" }: { label: string; value: string | number; detail?: string; tone?: string }) {
  return <div className="pixie-panel p-4"><p className="text-xs text-text-muted">{label}</p><p className={`mt-5 text-2xl ${tone}`}>{value}</p>{detail && <p className="mt-2 text-[11px] text-text-muted">{detail}</p>}</div>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = /resolved|healthy|active/i.test(status) ? "text-mint border-mint/30 bg-mint/5" : /failed|stale|attention/i.test(status) ? "text-brand border-brand/30 bg-brand/5" : "text-tang border-tang/30 bg-tang/5";
  return <span className={`inline-flex rounded-sm border px-2 py-1 text-[10px] ${tone}`}>{status}</span>;
}
