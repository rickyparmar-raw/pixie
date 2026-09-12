import Link from "next/link";
import { WorkspaceNav, ProgramNav, MobileProgramNav } from "./SidebarNav";
import { ThemeToggle } from "./ThemeToggle";
import { IconSearch, IconBell, IconChevronRight, IconDoc } from "./icons";

export function DashboardShell({
  children,
  programId,
  programName,
  crumb = "Overview",
  userName,
  userEmail,
  showWorkspaceNav = true,
}: {
  children: React.ReactNode;
  programId?: string;
  programName?: string;
  // Second breadcrumb segment for workspace-level pages (no program in scope).
  // Ignored when programName is set — that always wins the crumb.
  crumb?: string;
  // Signed-in user, for the sidebar profile footer. Omitted entirely (not a
  // placeholder) when a caller hasn't threaded the session through yet.
  userName?: string;
  userEmail?: string;
  // Overview/Programs/People are superadmin-only (see requireWizardSuperadmin)
  // — showing them to anyone else would just be a nav item that redirects the
  // moment it's clicked. Defaults true because every workspace-level page
  // that renders this shell directly is itself already superadmin-gated;
  // the one caller that isn't (the per-program layout, used by everyone)
  // passes the real value explicitly.
  showWorkspaceNav?: boolean;
}) {
  const homeHref = programId ? `/programs/${programId}` : "/overview";
  return (
    <div className="min-h-screen bg-ink text-text">
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-[240px] flex-col border-r border-line bg-ink px-3 py-5 lg:flex">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Link href={homeHref} className="flex items-center gap-1.5 pl-1 font-heading text-lg font-extrabold tracking-tight text-text">
            pixie
            <span className="mb-2.5 size-[7px] rounded-full bg-gradient-to-br from-brand to-mint" aria-hidden="true" />
          </Link>

          {showWorkspaceNav && (
            <>
              <p className="mt-8 pl-1 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted/70">Workspace</p>
              <WorkspaceNav />
            </>
          )}

          {programId && (
            <>
              <div className="my-5 border-t border-line" />
              <div className="flex items-center gap-2 pl-1 text-xs">
                <span className="grid size-5 shrink-0 place-items-center rounded-[6px] bg-gradient-to-br from-brand/25 to-mint/25 text-[9px] font-semibold text-text">
                  {programName?.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate text-text">{programName}</span>
              </div>
              <p className="mt-5 pl-1 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted/70">Program</p>
              <ProgramNav programId={programId} />
            </>
          )}
        </div>

        <Link
          href={programId ? `/programs/${programId}/knowledge` : "/programs"}
          className="pixie-button pixie-button-quiet mt-6 shrink-0 justify-start gap-2 text-xs"
        >
          <IconDoc size={14} /> View docs
        </Link>

        {userName && (
          <form action="/api/auth/logout" method="post" className="mt-4 shrink-0 border-t border-line pt-4">
            <button type="submit" className="flex w-full items-center gap-2.5 text-left text-xs">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand text-[11px] font-semibold text-on-brand">
                {userName.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text">{userName}</span>
                {userEmail && <span className="block truncate text-text-muted">{userEmail}</span>}
              </span>
              <IconChevronRight size={14} className="shrink-0 text-text-muted" />
            </button>
          </form>
        )}
      </aside>

      <div className="lg:pl-[240px]">
        <header className="flex min-h-[64px] flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-6 py-3.5 lg:px-8">
          <div className="text-xs text-text-muted">
            <Link href={homeHref} className="text-text hover:text-brand">pixie</Link>
            <span className="px-2 text-text-muted/50">/</span>
            {programName ?? crumb}
          </div>

          {programId && (
            <form action={`/programs/${programId}/tickets`} className="order-3 w-full lg:order-none lg:ml-2 lg:max-w-xs lg:flex-1">
              <label className="relative block">
                <IconSearch size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <input name="q" type="search" placeholder="Search tickets…" className="pixie-input pl-8 text-xs" />
              </label>
            </form>
          )}

          <div className="ml-auto flex items-center gap-3">
            <Link href="/wizard?mode=hosted" className="text-xs text-text-muted hover:text-text">
              New program
            </Link>
            <ThemeToggle />
            {programId && (
              <Link href={`/programs/${programId}/incidents`} aria-label="Incidents" className="grid size-7 place-items-center rounded-[5px] text-text-muted transition-colors hover:text-text">
                <IconBell size={15} />
              </Link>
            )}
          </div>
          {programId && <MobileProgramNav programId={programId} />}
        </header>
        <main className="mx-auto max-w-[1440px] px-6 py-10 lg:px-10">{children}</main>
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
    <div className="mb-8 flex items-start justify-between gap-6">
      <div>
        <h1 className="font-heading text-xl text-text">{title}</h1>
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
          {title && (
            <h2 className="flex items-center gap-2 text-sm font-medium text-text">
              <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
              {title}
            </h2>
          )}
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
      <p className={`mt-1 font-mono text-xl tabular-nums ${tone}`}>{value}</p>
      {detail && <p className="mt-1 text-[11px] text-text-muted">{detail}</p>}
    </div>
  );
}

// The bordered, icon-chip variant for a dashboard's top-of-page stat row —
// MetricCard's denser cousin for a surface that wants a card, not a bare
// number. `iconTone` sets the chip's background; keep it a low-alpha mix of
// the same token `tone` uses so the two always pair (see StatCard callers).
export function StatCard({
  label,
  value,
  detail,
  icon,
  tone = "text-text",
  iconTone = "bg-panel-2",
  barTone = "bg-line",
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon: React.ReactNode;
  tone?: string;
  iconTone?: string;
  // The thin top accent's color — pass the solid form of `tone` (e.g.
  // "bg-tang" alongside "text-tang") so the card reads as one color story
  // at a glance, not just from its icon chip.
  barTone?: string;
}) {
  return (
    <div className="pixie-panel group relative overflow-hidden p-4 transition-shadow hover:shadow-[0_6px_20px_-8px_rgba(20,30,15,0.18)]">
      <span className={`absolute inset-x-0 top-0 h-[3px] ${barTone}`} aria-hidden />
      <div className="flex items-center gap-2.5">
        <span className={`grid size-7 shrink-0 place-items-center rounded-full ${iconTone} ${tone}`}>{icon}</span>
        <p className="text-[13px] text-text-muted">{label}</p>
      </div>
      <p className={`mt-3 font-heading text-[28px] font-semibold leading-none tabular-nums ${tone}`}>{value}</p>
      {detail && <p className="mt-2 text-xs text-text-muted">{detail}</p>}
    </div>
  );
}

// Label left, value right — the list form, for a short run of numbers that
// belong together (e.g. the overview ticket summary).
export function MetricRow({ label, value, tone = "text-text" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-text-muted">{label}</span>
      <span className={`font-mono text-sm tabular-nums ${tone}`}>{value}</span>
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

/* ---------------------------------------------------------------------------
   Support Signal — the shared visual language. A request moves
   question → answer → ticket → human → resolved → knowledge; these
   primitives render that motion from real counts and rows, never decoration.
--------------------------------------------------------------------------- */

// Operational text: ids, timestamps, states, source keys. Sans is the default
// voice now, so machine text asks for mono explicitly.
export function Mono({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`font-mono ${className}`}>{children}</span>;
}

function toneForStatus(s: string): string {
  if (/resolved|healthy|active|synced|answered|ok\b/i.test(s)) return "bg-mint";
  if (/fail|stale|critical|escalat|attention|reopen|error/i.test(s)) return "bg-brand";
  if (/wait|pending|assigned|claim|review|candidate/i.test(s)) return "bg-tang";
  return "bg-text-muted";
}

// Bare semantic dot + optional label. StatusBadge (above) is the same idea
// with brand/mint/tang text colour; this one keeps the label in muted text
// and only the dot carries state — quieter, for dense rows.
export function StatusDot({ status, children }: { status: string; children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-text-muted">
      <span className={`size-1.5 shrink-0 rounded-full ${toneForStatus(status)}`} aria-hidden />
      {children ?? status}
    </span>
  );
}

export type Stage = { label: string; value: string | number; sub?: string; tone?: string };

// The support-signal rail: a horizontal run of stages joined by a thin
// connector with a node. `142 ──•── 98 ──•── 31 ──•── 120`, labels beneath.
export function SignalRail({ stages, className = "" }: { stages: Stage[]; className?: string }) {
  return (
    <ol className={`flex items-start overflow-x-auto pb-1 ${className}`}>
      {stages.map((s, i) => (
        <li key={s.label} className="flex shrink-0 items-start">
          <div className="min-w-[6.5rem] pr-1">
            <div className={`font-mono text-2xl leading-none tabular-nums ${s.tone ?? "text-text"}`}>{s.value}</div>
            <div className="mt-1.5 text-xs text-text-muted">{s.label}</div>
            {s.sub ? <div className="mt-0.5 font-mono text-[11px] text-text-muted/70">{s.sub}</div> : null}
          </div>
          {i < stages.length - 1 && (
            <div aria-hidden className="mx-1 flex items-center gap-1 pt-2.5 text-line sm:mx-2">
              <span className="h-px w-5 bg-current sm:w-9" />
              <span className="size-1 rounded-full bg-current" />
              <span className="h-px w-5 bg-current sm:w-9" />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

// One normalised horizontal bar. Widths share a `max` across a BarList so the
// bars are comparable. The row is fully legible without the bar (screen
// readers get label + value); the bar is the at-a-glance layer.
export function MiniBar({
  label,
  value,
  max,
  tone = "bg-text-muted",
  display,
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  tone?: string;
  // What to show at the end of the row. Defaults to the raw value; pass a
  // formatted string (e.g. a duration) when the bar is proportional to
  // something that shouldn't be printed literally.
  display?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const width = value > 0 ? Math.max(pct, 2) : 0;
  return (
    <div className="grid grid-cols-[8.5rem_1fr_3rem] items-center gap-3 text-sm">
      <span className="truncate text-text-muted">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-line/50">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
      </span>
      <span className="text-right font-mono tabular-nums text-text">{display ?? value}</span>
    </div>
  );
}

export function BarList({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

// A dense list row: optional mono lead (an id), primary text that can link,
// a trailing meta cluster. Used by tickets, audit, knowledge, incidents,
// helpers — anywhere the page is really a ledger.
export function DataRow({
  href,
  lead,
  title,
  meta,
  sub,
}: {
  href?: string;
  lead?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  sub?: React.ReactNode;
}) {
  const body = (
    <div className="-mx-2.5 flex items-baseline gap-3 rounded-md px-2.5 py-2 transition-colors group-hover:bg-panel-2/70">
      {lead != null && <span className="shrink-0 font-mono text-xs text-text-muted">{lead}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-text group-hover:text-brand">{title}</span>
        {sub != null && <span className="mt-0.5 truncate text-xs text-text-muted">{sub}</span>}
      </span>
      {meta != null && <span className="shrink-0 text-xs text-text-muted">{meta}</span>}
    </div>
  );
  return href ? (
    <Link href={href} prefetch={false} className="group block">
      {body}
    </Link>
  ) : (
    <div className="group">{body}</div>
  );
}

// Empty state: one plain line of what would be here, one line of why it
// isn't. No illustration, no confetti.
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-1 text-sm">
      <p className="text-text">{title}</p>
      {hint ? <p className="mt-1 text-text-muted">{hint}</p> : null}
    </div>
  );
}
