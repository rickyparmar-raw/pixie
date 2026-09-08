import Link from "next/link";
import { WorkspaceNav, ProgramNav, MobileProgramNav } from "./SidebarNav";

export function DashboardShell({
  children,
  programId,
  programName,
  crumb = "Overview",
}: {
  children: React.ReactNode;
  programId?: string;
  programName?: string;
  // Second breadcrumb segment for workspace-level pages (no program in scope).
  // Ignored when programName is set — that always wins the crumb.
  crumb?: string;
}) {
  return (
    <div className="min-h-screen bg-ink text-text">
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-[240px] border-r border-line bg-ink px-3 py-5 lg:block">
        <Link href="/overview" className="flex items-center gap-2 pl-1 text-sm">
          <span className="size-4 rounded-[3px] bg-brand" aria-hidden />
          pixie
        </Link>

        <p className="mt-8 pl-1 text-[11px] text-text-muted">Workspace</p>
        <WorkspaceNav />

        {programId && (
          <>
            <div className="my-5 border-t border-line" />
            <div className="flex items-center gap-2 pl-1 text-xs">
              <span className="grid size-5 shrink-0 place-items-center rounded-[3px] bg-panel-2 text-[9px] text-text-muted">
                {programName?.slice(0, 2).toUpperCase()}
              </span>
              <span className="truncate text-text">{programName}</span>
            </div>
            <p className="mt-5 pl-1 text-[11px] text-text-muted">Program</p>
            <ProgramNav programId={programId} />
          </>
        )}
      </aside>

      <div className="lg:pl-[240px]">
        <header className="flex min-h-[64px] flex-wrap items-center gap-x-6 gap-y-3 border-b border-line px-6 py-3.5 lg:px-8">
          <div className="text-xs text-text-muted">
            <Link href="/overview" className="text-text hover:text-brand">pixie</Link>
            <span className="px-2 text-text-muted/50">/</span>
            {programName ?? crumb}
          </div>
          <Link href="/wizard?mode=hosted" className="ml-auto text-xs text-text-muted hover:text-text">
            New program
          </Link>
          {programId && <MobileProgramNav programId={programId} />}
        </header>
        <main className="mx-auto max-w-[1080px] px-6 py-10 lg:px-10">{children}</main>
      </div>
    </div>
  );
}

// Compact page header: title, one optional line of context, optional action.
// No eyebrow, no badges row, no decorative icons — the breadcrumb in the
// shell header already says which program you're in.
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-9 flex items-start justify-between gap-6">
      <div>
        <h1 className="text-lg font-medium text-text">{title}</h1>
        {description && <p className="mt-1.5 max-w-prose text-sm text-text-muted">{description}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

// A section is a heading and its content separated by space — not a card.
// Pass `bordered` only when the content genuinely benefits from a surface
// (a nested form, a callout). Space sections apart with a `space-y-12`
// wrapper on the page.
export function Section({
  title,
  description,
  actions,
  bordered,
  children,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={bordered ? "pixie-panel p-5" : undefined}>
      {(title || actions) && (
        <div className="flex items-baseline justify-between gap-4">
          {title && <h2 className="text-sm font-medium text-text">{title}</h2>}
          {actions}
        </div>
      )}
      {description && <p className="mt-1 max-w-prose text-xs text-text-muted">{description}</p>}
      <div className={title || description ? "mt-4" : undefined}>{children}</div>
    </section>
  );
}

// One metric: label above, value below. No border, no icon. Drop these into
// a grid and they read as an aligned group.
export function MetricCard({
  label,
  value,
  detail,
  tone = "text-text",
}: {
  label: string;
  value: string | number;
  detail?: string;
  tone?: string;
}) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`mt-1.5 text-2xl tabular-nums ${tone}`}>{value}</p>
      {detail && <p className="mt-1 text-[11px] text-text-muted">{detail}</p>}
    </div>
  );
}

// Label left, value right — the list form, for a short run of numbers that
// belong together (e.g. the overview ticket summary).
export function MetricRow({ label, value, tone = "text-text" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-text-muted">{label}</span>
      <span className={`text-sm tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = /resolved|healthy|active/i.test(status)
    ? "text-mint"
    : /failed|stale|attention|critical/i.test(status)
      ? "text-brand"
      : "text-tang";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {status}
    </span>
  );
}

// The one shape for "a Core read failed on this page". Calm: a left rule and
// a plain sentence, no box, no "is Core running?" rhetorical question.
export function CoreError({ message }: { message: string }) {
  return (
    <p className="my-6 border-l-2 border-brand/60 pl-3 text-sm text-text-muted">
      {message} Pixie Core may be restarting; this page will recover on its own.
    </p>
  );
}
