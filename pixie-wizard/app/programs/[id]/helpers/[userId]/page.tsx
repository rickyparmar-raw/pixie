import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreHelperStats, type CoreHelperStats } from "@/lib/pixieCore";
import { resolveIdentities, identityLabel } from "@/lib/identity";
import { PageHeader, Section, CoreError, EmptyState, StatusDot } from "@/app/_components/DashboardShell";
import { StrengthRadar, type Strength } from "@/app/_components/charts/StrengthRadar";
import { HelperRadar } from "@/app/_components/charts/HelperRadar";

function duration(value: number | null): string {
  if (value === null) return "Unavailable";
  const minutes = Math.round(value / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function percent(value: number | null): string {
  return value === null ? "Unavailable" : `${Math.round(value * 100)}%`;
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
  if (!helper) return <><PageHeader title="Helper not found" description="This helper is not part of this program." /><Link className="text-brand underline" href={`/programs/${id}/helpers`}>Back to helpers</Link></>;
  const identities = await resolveIdentities([userId]);
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
      detail: duration(helper.medianFirstResponseMs),
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

  return <>
    <PageHeader title={name} description={`${helper.role} · program-scoped helper profile`} />
    <div className="space-y-10">
      <p><Link className="text-brand underline" href={`/programs/${id}/helpers`}>Back to helpers</Link></p>
      <Section title="Profile" description="Five measures, each scored against the rest of this program's helpers.">
        <HelperRadar dimensions={dimensions} />
      </Section>
      <Section title="Specialties" description="What this helper actually works on — counted from stored tickets, never declared.">
        {strengths.length >= 3 ? (
          <StrengthRadar strengths={strengths} />
        ) : (
          <div className="space-y-2">
            {strengths.length ? (
              strengths.map((entry) => (
                <div key={entry.tag} className="flex justify-between border-b border-line py-2 text-sm last:border-0">
                  <span>{entry.tag}</span>
                  <span className="font-mono text-text-muted">
                    <span className="text-text">{entry.resolved}</span> resolved · {entry.replies} replied
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm text-text-muted">Nothing observed yet — specialties appear once this helper answers or resolves tickets.</p>
            )}
            {strengths.length > 0 && (
              <p className="pt-2 text-xs text-text-muted">A radar appears here once there are three categories to compare.</p>
            )}
          </div>
        )}
        <p className="mt-5 text-xs text-text-muted">Declared tags: {helper.expertise.length ? helper.expertise.map((entry) => entry.tag).join(", ") : "none"}.</p>
      </Section>
      <Section title="Stats">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-7 sm:grid-cols-4">
          {[
            ["Resolved", String(helper.totals.resolved)],
            ["Open load", String(helper.totals.open)],
            ["First response", duration(helper.medianFirstResponseMs)],
            ["Resolution", duration(helper.medianResolutionMs)],
            ["Reopen rate", percent(helper.reopenRate)],
            ["Helpful", percent(helper.helpfulPercentage)],
            ["Last active", helper.lastActivity ? new Date(helper.lastActivity).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—"],
          ].map(([label, value]) => (
            <div key={label}>
              <dd className="font-mono text-[26px] leading-none tabular-nums text-text">{value}</dd>
              <dt className="mt-2.5 text-[13px] text-text-muted">{label}</dt>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Recent tickets" description="Only tickets assigned or resolved by this helper in this program.">
        {helper.recentTickets.length ? (
          <ul className="divide-y divide-line">
            {helper.recentTickets.map((ticket) => (
              <li key={String(ticket.id)} className="flex items-baseline justify-between gap-4 py-3">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-text-muted">#{String(ticket.id)}</span>
                  <span className="ml-2.5 text-sm text-text">{String(ticket.category)}</span>
                  {ticket.reopened ? <span className="ml-2 text-[11px] text-tang">reopened</span> : null}
                </div>
                <div className="flex shrink-0 items-baseline gap-4 text-[11px] text-text-muted">
                  <StatusDot status={String(ticket.status)} />
                  <span className="font-mono tabular-nums">
                    {ticket.resolvedAt
                      ? new Date(Number(ticket.resolvedAt)).toLocaleDateString()
                      : ticket.assignedAt
                        ? new Date(Number(ticket.assignedAt)).toLocaleDateString()
                        : "—"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No ticket history yet." hint="Tickets this helper is assigned or resolves show up here." />
        )}
      </Section>
      <Section title="Assignments" description="Claim, decline, release and timeout — a lifecycle, not a ranking.">
        <div className="flex flex-wrap items-baseline gap-x-10 gap-y-5">
          <div>
            <p className="font-mono text-[26px] leading-none tabular-nums text-text">
              {helper.acceptRate === null ? "—" : percent(helper.acceptRate)}
            </p>
            <p className="mt-2.5 text-[13px] text-text">
              {helper.acceptRate === null
                ? "Accept rate — not enough data"
                : `Accept rate · ${helper.assignments.claimed} of ${helper.assignments.completedOffers}`}
            </p>
          </div>
          <dl className="flex flex-wrap gap-x-7 gap-y-2 text-xs text-text-muted">
            {[
              ["Offered", helper.assignments.offered],
              ["Claimed", helper.assignments.claimed],
              ["Declined", helper.assignments.declined],
              ["Released", helper.assignments.released],
              ["Timed out", helper.assignments.timedOut],
            ].map(([label, n]) => (
              <div key={String(label)} className="flex items-baseline gap-1.5">
                <dd className="font-mono tabular-nums text-text">{String(n)}</dd>
                <dt>{String(label).toLowerCase()}</dt>
              </div>
            ))}
          </dl>
        </div>
        <p className="mt-4 text-xs text-text-muted">
          {helper.assignmentLifecycle === "supported"
            ? `Rate = claimed offers ÷ completed offers (${helper.assignments.completedOffers} completed).`
            : helper.assignmentLifecycle === "insufficient"
              ? `Only ${helper.assignments.completedOffers} completed offer${helper.assignments.completedOffers === 1 ? "" : "s"} so far — the rate stays hidden until there are more.`
              : "No claim/decline lifecycle recorded for this helper yet."}
        </p>
      </Section>
      <Section title="Routing profile">
        <p className="text-sm text-text-muted">Explicit expertise: {helper.expertise.length ? helper.expertise.map((entry) => entry.tag).join(", ") : "none"}.</p>
      </Section>
    </div>
  </>;
}
