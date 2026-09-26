import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreHelperStats, type CoreHelperStats } from "@/lib/pixieCore";
import { resolveIdentities, identityLabel } from "@/lib/identity";
import {
  BarList,
  Chip,
  CoreError,
  EmptyState,
  MetricCard,
  MiniBar,
  Notice,
  PageHeader,
  Section,
  StatusDot,
} from "@/app/_components/DashboardShell";
import { shortTime, timeAgo } from "@/app/_components/format";
import { IconArrowRight } from "@/app/_components/icons";
import { StrengthRadar, type Strength } from "@/app/_components/charts/StrengthRadar";
import { HelperRadar } from "@/app/_components/charts/HelperRadar";

// null means "Pixie has no measure for this" — each caller decides whether that
// prints as an em dash, an em dash plus "unavailable", or a sentence.
function duration(value: number | null): string | null {
  if (value === null) return null;
  const minutes = Math.round(value / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function percent(value: number | null): string | null {
  return value === null ? null : `${Math.round(value * 100)}%`;
}

// A calendar date in the product's own order — the same month-first stamp
// `shortTime` and the volume chart use — so this page never prints a third
// date style beside the two the rest of the dashboard already has.
function dayLabel(value: number | string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// A 28px figure never prints a word: a measure nobody has recorded is an em
// dash with "unavailable" underneath, so one long word can't stretch a column.
function figure(value: string | null): { value: string; detail?: string } {
  return value === null ? { value: "—", detail: "unavailable" } : { value };
}

// The onboarding's person tile: a 1px outlined square holding either a real
// Slack avatar (pixelated, so a photo can never soften the world) or the
// person's initial in the pixel face.
function HelperAvatar({ label, avatarUrl }: { label: string; avatarUrl: string | null }) {
  const initial = (label.startsWith("@") ? label.slice(1) : label).slice(0, 1).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[2px] border border-line-strong bg-panel-2 font-display text-[16px] leading-none text-text"
    >
      {avatarUrl ? <img src={avatarUrl} alt="" className="pixel-art size-full object-cover" /> : initial}
    </span>
  );
}

// A labelled run of figures. A flat grid of seven ends on a ragged row; a run
// of four and a run of three both fill their line, and the labels say which
// group a number belongs to.
function MetricRun({
  title,
  cells,
  columns,
  className = "",
}: {
  title: string;
  cells: Array<{ label: string; value: string; detail?: string; tone?: string }>;
  columns: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
        <span className="pixie-mark" aria-hidden="true" />
        {title}
      </p>
      <div className={`mt-4 grid grid-cols-2 gap-x-6 gap-y-5 ${columns}`}>
        {cells.map((cell) => (
          <MetricCard key={cell.label} label={cell.label} value={cell.value} detail={cell.detail} tone={cell.tone} />
        ))}
      </div>
    </div>
  );
}

export default async function HelperProfilePage({ params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  await requireProgramMembership(id);
  let stats: CoreHelperStats;
  try {
    stats = await coreHelperStats(id);
  } catch (error) {
    return <><PageHeader title="Helper profile" description="Program-scoped routing and support history." /><CoreError message={error instanceof Error ? error.message : "Helper stats are unavailable."} /></>;
  }
  const helper = stats.helpers.find((entry) => entry.userId === userId);
  if (!helper) return <><PageHeader title="Helper not found" description="This helper is not part of this program." /><Link className="pixie-button pixie-button-quiet" href={`/programs/${id}/helpers`}><IconArrowRight size={16} className="rotate-180" />Back to helpers</Link></>;
  const identities = await resolveIdentities([userId]);
  const identity = identities.get(userId);
  const name = identityLabel(identities.get(userId), userId);

  // Five fixed axes, each 0-100, scored against the rest of this roster so a
  // program with 20 tickets and one with 20,000 both read as a shape.
  const roster = stats.helpers;
  const topResolved = Math.max(1, ...roster.map((h) => h.totals.resolved));
  const responses = roster.map((h) => h.medianFirstResponseMs).filter((v): v is number => v !== null && v > 0);
  const slowest = responses.length ? Math.max(...responses) : null;
  const categoryCount = new Set(roster.flatMap((h) => h.categoryResolved.map((c) => c.category))).size;
  const covered = helper.categoryResolved.length;

  const pct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 100)));
  const dimensions = [
    {
      key: "volume", label: "Volume",
      score: pct(helper.totals.resolved / topResolved),
      detail: `${helper.totals.resolved} resolved`,
    },
    {
      key: "speed", label: "Speed",
      score: helper.medianFirstResponseMs === null || slowest === null
        ? null
        : pct(1 - helper.medianFirstResponseMs / slowest),
      detail: duration(helper.medianFirstResponseMs) ?? "no data",
    },
    {
      key: "breadth", label: "Breadth",
      score: categoryCount ? pct(covered / categoryCount) : null,
      detail: `${covered} of ${categoryCount || 0} areas`,
    },
    {
      key: "reliability", label: "Reliability",
      score: helper.reopenRate === null ? null : pct(1 - helper.reopenRate),
      detail: helper.reopenRate === null ? "no data" : `${percent(helper.reopenRate)} reopened`,
    },
    {
      key: "followThrough", label: "Follow-through",
      score: helper.acceptRate === null ? null : pct(helper.acceptRate),
      detail: helper.acceptRate === null ? "too few offers" : `${helper.assignments.claimed}/${helper.assignments.completedOffers} taken`,
    },
  ];

  // Two sources, merged by category.
  const byTag = new Map<string, Strength>();
  for (const entry of helper.categoryResolved) {
    byTag.set(entry.category, { tag: entry.category, resolved: entry.resolved, replies: 0 });
  }
  for (const entry of helper.expertise) {
    const found = byTag.get(entry.tag) ?? { tag: entry.tag, resolved: 0, replies: 0 };
    found.replies = entry.reply_count ?? 0;
    byTag.set(entry.tag, found);
  }
  const strengths = [...byTag.values()]
    .filter((s) => s.resolved > 0 || s.replies > 0)
    .sort((a, b) => b.resolved + b.replies * 0.2 - (a.resolved + a.replies * 0.2));

  const statCells: {
    label: string;
    value: string;
    detail?: string;
    tone?: string;
    group: "Throughput" | "Quality";
  }[] = [
    { group: "Throughput", label: "Resolved", value: String(helper.totals.resolved) },
    {
      group: "Throughput",
      label: "Open load",
      value: String(helper.totals.open),
      tone: helper.totals.open > 0 ? "text-tang" : undefined,
    },
    { group: "Throughput", label: "First response", ...figure(duration(helper.medianFirstResponseMs)) },
    { group: "Throughput", label: "Resolution", ...figure(duration(helper.medianResolutionMs)) },
    {
      group: "Quality",
      label: "Reopen rate",
      ...figure(percent(helper.reopenRate)),
      tone: helper.reopenRate ? "text-danger" : undefined,
    },
    { group: "Quality", label: "Helpful", ...figure(percent(helper.helpfulPercentage)) },
    {
      group: "Quality",
      label: "Last active",
      ...figure(helper.lastActivity ? dayLabel(helper.lastActivity) : null),
    },
  ];
  const throughput = statCells.filter((cell) => cell.group === "Throughput");
  const quality = statCells.filter((cell) => cell.group === "Quality");

  return <>
    <PageHeader
      title={name}
      description="Program-scoped helper profile."
      actions={
        <Link href={`/programs/${id}/helpers`} className="pixie-button pixie-button-quiet">
          <IconArrowRight size={16} className="rotate-180" />
          Back to helpers
        </Link>
      }
    />

    {/* The byline under the name, not a second name card: the avatar, the id,
        the role and the last-activity stamp are exactly what the H1 above
        doesn't already say, so the page never prints the name twice. */}
    <div className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-2">
      <HelperAvatar label={name} avatarUrl={identity?.avatarUrl ?? null} />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[13px] text-text-muted">@{userId}</span>
        <Chip>{helper.role}</Chip>
        <span className="text-[13px] text-text-muted">
          {helper.lastActivity ? `Last active ${timeAgo(helper.lastActivity)}` : "No activity recorded"}
        </span>
      </span>
    </div>

    <div className="space-y-8">
      <Section title="Profile" description="Five measures, each scored against the rest of this program's helpers." bordered>
        <HelperRadar dimensions={dimensions} />
      </Section>

      <Section title="Specialties" description="What this helper actually works on — counted from stored tickets, never declared." bordered>
        {strengths.length >= 3 ? (
          <StrengthRadar strengths={strengths} />
        ) : strengths.length ? (
          <div className="space-y-3">
            <ul className="divide-y divide-line">
              {strengths.map((entry) => (
                <li key={entry.tag} className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
                  <span className="text-text">{entry.tag}</span>
                  <span className="font-mono text-text-muted">
                    <span className="text-text">{entry.resolved}</span> resolved · {entry.replies} replied
                  </span>
                </li>
              ))}
            </ul>
            <Notice tone="info">A radar appears here once there are three categories to compare.</Notice>
          </div>
        ) : (
          <EmptyState
            title="Nothing observed yet."
            hint="Specialties appear once this helper answers or resolves tickets."
          />
        )}
      </Section>

      <Section title="Stats" description="Split so throughput and quality can be read apart.">
        <MetricRun title="Throughput" cells={throughput} columns="sm:grid-cols-2 lg:grid-cols-4" />
        <MetricRun title="Quality" cells={quality} columns="sm:grid-cols-3" className="mt-7" />
      </Section>

      <Section title="Recent tickets" description="Only tickets assigned or resolved by this helper in this program.">
        {helper.recentTickets.length ? (
          <table className="pixie-table">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Status</th>
                <th className="text-right">Date</th>
              </tr>
            </thead>
            <tbody>
              {helper.recentTickets.map((ticket) => (
                <tr key={String(ticket.id)}>
                  <td>
                    <span className="font-mono text-xs text-text-muted">#{String(ticket.id)}</span>
                    <span className="ml-2.5">{String(ticket.category)}</span>
                    {ticket.reopened ? (
                      <span className="ml-2 inline-flex items-center gap-1.5 text-[11px] text-tang">
                        <span className="size-1.5 shrink-0 rounded-[1px] bg-tang" aria-hidden />
                        reopened
                      </span>
                    ) : null}
                  </td>
                  <td><StatusDot status={String(ticket.status)} /></td>
                  <td className="whitespace-nowrap text-right font-mono tabular-nums text-text-muted">
                    {ticket.resolvedAt
                      ? shortTime(Number(ticket.resolvedAt))
                      : ticket.assignedAt
                        ? shortTime(Number(ticket.assignedAt))
                        : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No ticket history yet." hint="Tickets this helper is assigned or resolves show up here." />
        )}
      </Section>

      <Section title="Assignments" description="Claim, decline, release and timeout — a lifecycle, not a ranking.">
        <div className="grid gap-6 sm:grid-cols-[13rem_1fr] sm:items-start sm:gap-8">
          <MetricCard
            label="Accept rate"
            value={percent(helper.acceptRate) ?? "—"}
            detail={
              helper.acceptRate === null
                ? "not enough data"
                : `${helper.assignments.claimed} of ${helper.assignments.completedOffers} completed offers`
            }
          />
          <BarList>
            <MiniBar label="Offered" value={helper.assignments.offered} max={Math.max(helper.assignments.offered, 1)} tone="bg-line-strong" />
            <MiniBar label="Claimed" value={helper.assignments.claimed} max={Math.max(helper.assignments.offered, 1)} tone="bg-mint" />
            <MiniBar label="Declined" value={helper.assignments.declined} max={Math.max(helper.assignments.offered, 1)} tone="bg-tang" />
            <MiniBar label="Released" value={helper.assignments.released} max={Math.max(helper.assignments.offered, 1)} tone="bg-tang" />
            <MiniBar label="Timed out" value={helper.assignments.timedOut} max={Math.max(helper.assignments.offered, 1)} tone="bg-danger" />
          </BarList>
        </div>
        <p className="mt-5 max-w-[70ch] text-[12px] text-text-muted">
          {helper.assignmentLifecycle === "supported"
            ? `Rate = claimed offers ÷ completed offers (${helper.assignments.completedOffers} completed).`
            : helper.assignmentLifecycle === "insufficient"
              ? `Only ${helper.assignments.completedOffers} completed offer${helper.assignments.completedOffers === 1 ? "" : "s"} so far — the rate stays hidden until there are more.`
              : "No claim/decline lifecycle recorded for this helper yet."}
        </p>
      </Section>

      <Section title="Routing profile" description="Explicit expertise — the tags routing matches on — and what each has answered.">
        {helper.expertise.length ? (
          <ul className="divide-y divide-line">
            {helper.expertise.map((entry) => (
              <li key={entry.tag} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
                <Chip>{entry.tag}</Chip>
                <span className="font-mono text-[13px] text-text-muted">
                  <span className="text-text">{entry.solved_count}</span> solved · {entry.reply_count} replied
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No explicit expertise."
            hint="Pixie still routes to this helper when no tag matches anything else."
          />
        )}
      </Section>
    </div>
  </>;
}
