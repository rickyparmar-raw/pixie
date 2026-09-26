import Link from "next/link";
import { WorkspaceNav, ProgramNav, MobileProgramNav } from "./SidebarNav";
import { ThemeToggle } from "./ThemeToggle";
import { Figure } from "./Figure";
import {
  IconSearch,
  IconBell,
  IconPlus,
  IconDoc,
  IconExit,
  IconInfo,
  IconAlert,
  IconCheck,
} from "./icons";

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
    <div className="pixie-night min-h-screen bg-ink text-text">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[240px] flex-col border-r border-line bg-ink px-3 py-5 lg:flex">
        <div className="pixie-nav-scroll min-h-0 flex-1 overflow-y-auto">
          <Link
            href={homeHref}
            className="flex items-start gap-2 font-display text-[24px] leading-none text-text"
          >
            pixie
            <span className="pixie-mark-bg mt-[5px] size-[7px] shrink-0" aria-hidden="true" />
          </Link>

          {showWorkspaceNav && (
            <>
              <Eyebrow className="mt-8">Workspace</Eyebrow>
              <WorkspaceNav />
            </>
          )}

          {programId && (
            <>
              <div className="my-5 border-t border-line" />
              <div className="flex items-center gap-2 pl-1 text-[13px]">
                <span className="grid size-5 shrink-0 place-items-center rounded-[2px] bg-lime/15 font-display text-[10px] leading-none text-lime">
                  {programName?.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate text-text">{programName}</span>
              </div>
              <Eyebrow className="mt-5">Program</Eyebrow>
              <ProgramNav programId={programId} />
            </>
          )}
        </div>

        <Link
          href={programId ? `/programs/${programId}/knowledge` : "/programs"}
          className="pixie-button pixie-button-quiet pixie-button-sm mt-6 w-full shrink-0 justify-start"
        >
          <IconDoc size={16} /> View docs
        </Link>

        {userName && (
          <form action="/api/auth/logout" method="post" className="mt-4 shrink-0 border-t border-line pt-4">
            <button
              type="submit"
              className="group flex w-full items-center gap-2.5 rounded-[2px] px-1.5 py-1.5 text-left"
            >
              {/* The initial is Inter at 600, not the pixel face: at 12px in a
                  28px tile a 1px-stroke pixel "L" reads as a speck rather than a
                  letter, and the tile is the one place the user's own name is
                  the whole content. */}
              <span className="grid size-7 shrink-0 place-items-center rounded-[2px] bg-lime text-[13px] leading-none font-semibold text-lime-ink">
                {userName.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-text">{userName}</span>
                {userEmail && <span className="block truncate text-[12px] text-text-muted">{userEmail}</span>}
              </span>
              <IconExit
                size={16}
                className="shrink-0 text-text-muted transition-colors group-hover:text-text"
              />
            </button>
          </form>
        )}
      </aside>

      {/* `min-h-[100dvh]` so a short page still ends at the viewport floor, and
          the bottom reserve -- the same `--pixie-art-band` the art box is cut
          to, so the two cannot disagree -- keeps the last panel clear of the
          horizon. Both collapse to nothing in day theme and below 1024px, where
          globals.css hides the art. */}
      <div className="relative z-10 min-h-[100dvh] pb-[var(--pixie-art-band)] lg:pl-[240px]">
        {/* Pixie's night world: the unedited skyline/water art, anchored to the
            bottom of this column in its own reserved band, so she reads under
            the last panel the way the onboarding places her under the preview
            panel — never through the gap between two of them. */}
        <div className="pixie-night-art" aria-hidden="true">
          <img src="/pixie-night-background.png" alt="" width={1672} height={940} />
        </div>

        <header className="flex min-h-[60px] flex-wrap items-center gap-x-4 gap-y-3 border-b border-line bg-ink/80 px-6 py-3 lg:px-10">
          <div className="flex items-center gap-2 text-[12px]">
            <Link href={homeHref} className="text-text transition-colors hover:text-brand">pixie</Link>
            <span className="text-line-strong" aria-hidden="true">/</span>
            <span className="truncate text-text-muted">{programName ?? crumb}</span>
          </div>

          {programId && (
            <form action={`/programs/${programId}/tickets`} className="order-3 w-full lg:order-none lg:ml-2 lg:max-w-xs lg:flex-1">
              <label className="relative block">
                <IconSearch size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
                {/* 30px, the height of the two square buttons beside it: the
                    field is a header control, not a form, and a 38px input
                    next to a 30px bell leaves the row reading as two sizes. */}
                <input name="q" type="search" placeholder="Search tickets…" className="pixie-input h-[30px] py-0 pl-9" />
              </label>
            </form>
          )}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Link href="/wizard?mode=hosted" className="pixie-button pixie-button-quiet pixie-button-sm">
              <IconPlus size={16} />
              New program
            </Link>
            <ThemeToggle />
            {programId && (
              <Link
                href={`/programs/${programId}/incidents`}
                aria-label="Incidents"
                className="pixie-icon-button"
              >
                <IconBell size={16} />
              </Link>
            )}
          </div>
          {programId && <MobileProgramNav programId={programId} />}
        </header>
        <main className="relative mx-auto max-w-[1440px] px-6 py-9 lg:px-10">{children}</main>
      </div>
    </div>
  );
}

// Eyebrow / section label: 11px uppercase, wide tracking, muted, always led by
// the 6px square lime marker. The one label style in the product — the sidebar
// section names, page eyebrows and section titles all use this.
function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`pixie-eyebrow flex items-center gap-2 text-text-muted ${className}`}>
      <span className="pixie-mark" aria-hidden="true" />
      {children}
    </p>
  );
}

// Compact page header: title, one optional line of context, optional action.
// The breadcrumb in the shell header already says which program you're in, so
// the eyebrow is reserved for pages that need a second word of orientation.
//
// On a phone the action drops to its own line under the description rather than
// being squeezed into a column beside it: a 34px pixel title and a button have
// no shared width there, and the button is what loses.
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col items-start gap-4 border-b border-line pb-6 sm:flex-row sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {eyebrow && <Eyebrow className="mb-3">{eyebrow}</Eyebrow>}
        <h1 className="font-display text-[26px] leading-[1.05] text-text sm:text-[34px]">
          {title}
        </h1>
        {description && <p className="mt-3 max-w-[60ch] text-sm text-text-muted">{description}</p>}
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
        <div className="flex items-center justify-between gap-4">
          {title && (
            <h2 className="pixie-eyebrow flex items-center gap-2 text-text-muted">
              <span className="pixie-mark" aria-hidden="true" />
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {description && <p className="mt-2 max-w-prose text-[13px] text-text-muted">{description}</p>}
      <div className={title || description ? "mt-4" : undefined}>{children}</div>
    </section>
  );
}

// One metric: value above, label below. No border, no icon. Drop these into
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
      <p className={`font-mono text-[28px] leading-none tabular-nums ${tone}`}><Figure value={value} /></p>
      <p className="mt-2.5 text-[13px] text-text">{label}</p>
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
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon: React.ReactNode;
  tone?: string;
  iconTone?: string;
  // Kept for call-site compatibility: the old card painted a 3px accent bar
  // across the top in this colour. The night card has no coloured bar — tone
  // lives in the icon tile and the figure — so the prop is accepted and
  // ignored rather than resurrected as a stripe.
  barTone?: string;
}) {
  return (
    <div className="pixie-panel p-4">
      <div className="flex items-center gap-2.5">
        <span className={`grid size-7 shrink-0 place-items-center rounded-[2px] ${iconTone} ${tone}`}>{icon}</span>
        <p className="text-[12px] text-text-muted">{label}</p>
      </div>
      <p className={`mt-3 font-mono text-[28px] leading-none tabular-nums ${tone}`}><Figure value={value} /></p>
      {detail && <p className="mt-2 text-[11px] text-text-muted">{detail}</p>}
    </div>
  );
}

// Label left, value right — the list form, for a short run of numbers that
// belong together (e.g. the overview ticket summary).
export function MetricRow({ label, value, tone = "text-text" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[13px] text-text-muted">{label}</span>
      <span className={`font-mono text-[13px] tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

// One semantic colour for a status string, used by both StatusBadge and
// StatusDot. Mint = resolved/healthy, tang = waiting on a person, danger =
// failed/stale/critical. Lime is never a failure — an escalated or reopened
// request is still live work, so it reads tang like every other wait.
//
// The order of the tests is the whole rule: a word that is both healthy and
// failing wins as healthy, and failing beats waiting. `confirmed` is a
// deliberate word boundary so a hypothetical `unconfirmed` (a burst Pixie saw
// but nobody has agreed to) stays tang, like every other un-reviewed candidate.
function toneForStatus(s: string): string {
  if (/resolved|healthy|active|synced|answered|ok\b/i.test(s)) return "mint";
  if (/fail|stale|critical|error|\bconfirmed\b/i.test(s)) return "danger";
  if (/wait|pending|assigned|claim|review|candidate|escalat|reopen|attention|paused|invited/i.test(s)) return "tang";
  // Everything else is history, not news: `dismissed` and `suppressed` land
  // here, grey on purpose — a call that was talked over and a rule that was
  // switched off are not states waiting on anybody.
  return "muted";
}

const TONE_TEXT: Record<string, string> = {
  mint: "text-mint",
  tang: "text-tang",
  danger: "text-danger",
  muted: "text-text-muted",
};

const TONE_MARK: Record<string, string> = {
  mint: "bg-mint",
  tang: "bg-tang",
  danger: "bg-danger",
  muted: "bg-text-muted",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[12px] ${TONE_TEXT[toneForStatus(status)]}`}>
      <span className="size-1.5 shrink-0 rounded-[1px] bg-current" aria-hidden />
      {status}
    </span>
  );
}

// The one shape for "a Core read failed on this page". Still the same honest
// sentence — a warning, restyled, never softened or hidden.
export function CoreError({ message }: { message: string }) {
  return (
    <div className="my-6">
      <Notice tone="warn">
        {message} Pixie Core may be restarting; this page will recover on its own.
      </Notice>
    </div>
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

// Bare semantic dot + optional label. StatusBadge (above) is the same idea
// with the same marker and the status in tone colour; this one keeps the label
// in muted text and only the marker carries state — quieter, for dense rows.
export function StatusDot({ status, children }: { status: string; children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-text-muted">
      <span className={`size-1.5 shrink-0 rounded-[1px] ${TONE_MARK[toneForStatus(status)]}`} aria-hidden />
      {children ?? status}
    </span>
  );
}

export type Stage = { label: string; value: string | number; sub?: string; tone?: string };

// The support-signal rail: a horizontal run of stages joined by a thin
// connector with a node. `142 ──■── 98 ──■── 31 ──■── 120`, labels beneath.
//
// Two layouts, one markup. From `sm` up there is room for the rail and the
// connectors are what carry the order. Below it — a phone — the rail was an
// overflow-x strip that cut a label in half mid-word with no scroll affordance
// and put the rest of the stages off-screen; there the stages are a two-column
// grid with the connectors dropped, because an arrow between two numbers has
// nothing to say once the two numbers sit side by side.
export function SignalRail({ stages, className = "" }: { stages: Stage[]; className?: string }) {
  return (
    <ol
      className={`grid grid-cols-2 gap-x-4 gap-y-4 pb-1 sm:flex sm:items-start sm:gap-y-0 sm:overflow-x-auto ${className}`}
    >
      {stages.map((s, i) => (
        <li key={s.label} className="flex min-w-0 items-start sm:shrink-0">
          <div className="min-w-0 sm:min-w-[6.5rem] sm:pr-1">
            <div className={`font-mono text-[24px] leading-none tabular-nums ${s.tone ?? "text-text"}`}>{s.value}</div>
            <div className="mt-1.5 text-[13px] text-text-muted">{s.label}</div>
            {s.sub ? <div className="mt-0.5 font-mono text-[11px] text-text-muted/80">{s.sub}</div> : null}
          </div>
          {i < stages.length - 1 && (
            <div aria-hidden className="mx-1 hidden items-center gap-1 pt-2.5 text-line-strong sm:mx-2 sm:flex">
              <span className="h-px w-5 bg-current sm:w-9" />
              <span className="size-[3px] rounded-[1px] bg-current" />
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
    <div className="grid grid-cols-[8.5rem_1fr_3rem] items-center gap-3 text-[13px]">
      <span className="truncate text-text-muted">{label}</span>
      <span className="block h-1.5 bg-line/60">
        <span className={`block h-full rounded-[1px] ${tone}`} style={{ width: `${width}%` }} />
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
//
// `min-w-0` on both the row and the element around it, and `overflow-hidden` on
// the row, are what make this safe to drop into any grid. Without them the
// wrapper's automatic minimum size is its min-content width — nowrap ids,
// timestamps and status words — and a `1fr` track grows to that instead of
// shrinking, pushing the neighbouring column off the page. With them the title
// column truncates and the row is bounded by its track, so the ledger can never
// be what makes a page scroll sideways.
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
    <div className="-mx-2.5 flex min-w-0 items-baseline gap-3 overflow-hidden rounded-[3px] px-2.5 py-2 transition-colors group-hover:bg-panel-2">
      {lead != null && <span className="shrink-0 font-mono text-xs text-text-muted">{lead}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-text transition-colors group-hover:text-brand">{title}</span>
        {sub != null && <span className="mt-0.5 truncate text-xs text-text-muted">{sub}</span>}
      </span>
      {meta != null && <span className="shrink-0 text-xs text-text-muted">{meta}</span>}
    </div>
  );
  return href ? (
    <Link href={href} prefetch={false} className="group block min-w-0">
      {body}
    </Link>
  ) : (
    <div className="group min-w-0">{body}</div>
  );
}

// Empty state: the mascot, one plain line of what would be here, one line of
// why it isn't. Dashed border, no illustration, no confetti.
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="pixie-empty">
      <img src="/pixie-hero.png" alt="" width={28} height={28} className="pixel-art pixie-empty-art" />
      <div className="min-w-0">
        <p className="pixie-empty-title">{title}</p>
        {hint ? <p className="pixie-empty-hint">{hint}</p> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ notices -- */

type Tone = "info" | "warn" | "error" | "success";

const NOTICE_ICON: Record<Tone, typeof IconInfo> = {
  info: IconInfo,
  warn: IconAlert,
  error: IconAlert,
  success: IconCheck,
};

// A banner for the things a page must not swallow: Core down, sync pending,
// metrics unavailable. The tone's border and icon colour are drawn by
// `.pixie-notice-*`; this adds the sprite, an optional bold lead line and the
// body copy.
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div className={`pixie-notice pixie-notice-${tone}`}>
      <Icon size={16} className="pixie-notice-icon" />
      <div className="pixie-notice-body">
        {title && <p className="pixie-notice-title">{title}</p>}
        {children}
      </div>
    </div>
  );
}

// A tag or pill — sync state, plan, category. `tone="lime"` is the one
// highlighted variant, for a state that's the product's headline.
export function Chip({ tone, children }: { tone?: "lime"; children: React.ReactNode }) {
  return <span className={`pixie-chip ${tone === "lime" ? "pixie-chip-lime" : ""}`}>{children}</span>;
}
