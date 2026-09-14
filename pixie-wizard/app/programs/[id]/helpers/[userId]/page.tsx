import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreHelperStats, type CoreHelperStats } from "@/lib/pixieCore";
import { resolveIdentities, identityLabel } from "@/lib/identity";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";
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
        <dl className="grid gap-4 sm:grid-cols-3">
          {[["Resolved", helper.totals.resolved], ["Open load", helper.totals.open], ["Median first response", duration(helper.medianFirstResponseMs)], ["Median resolution", duration(helper.medianResolutionMs)], ["Reopen rate", percent(helper.reopenRate)], ["Helpful", percent(helper.helpfulPercentage)], ["Last active", helper.lastActivity ? new Date(helper.lastActivity).toLocaleString() : "Unavailable"]].map(([label, value]) => <div key={String(label)}><dt className="text-xs text-text-muted">{label}</dt><dd className="mt-1 font-mono text-sm text-text">{String(value)}</dd></div>)}
        </dl>
      </Section>
      <Section title="Recent tickets" description="Only tickets assigned or resolved by this helper in this program.">
        {helper.recentTickets.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="font-mono text-xs uppercase text-text-muted"><tr><th className="py-2">Ticket</th><th>Category</th><th>State</th><th>Assigned</th><th>First response</th><th>Resolution</th><th>Reopened</th></tr></thead><tbody>{helper.recentTickets.map((ticket) => <tr key={String(ticket.id)} className="border-t border-line"><td className="py-2">#{String(ticket.id)}</td><td>{String(ticket.category)}</td><td>{String(ticket.status)}</td><td>{ticket.assignedAt ? new Date(Number(ticket.assignedAt)).toLocaleDateString() : "-"}</td><td>{ticket.firstResponseAt ? new Date(Number(ticket.firstResponseAt)).toLocaleDateString() : "-"}</td><td>{ticket.resolvedAt ? new Date(Number(ticket.resolvedAt)).toLocaleDateString() : "-"}</td><td>{ticket.reopened ? "yes" : "no"}</td></tr>)}</tbody></table></div> : <p className="text-sm text-text-muted">No ticket history yet.</p>}
      </Section>
      <Section title="Assignments" description="Explicit claim / decline / release / timeout lifecycle — not a performance ranking. Counts are raw; the rate needs a few completed offers before it means anything.">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-text-muted">Offered</dt>
            <dd className="mt-1 font-mono text-sm text-text">{helper.assignments.offered}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Claimed</dt>
            <dd className="mt-1 font-mono text-sm text-text">{helper.assignments.claimed}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Declined</dt>
            <dd className="mt-1 font-mono text-sm text-text">{helper.assignments.declined}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Released</dt>
            <dd className="mt-1 font-mono text-sm text-text">{helper.assignments.released}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Timed out</dt>
            <dd className="mt-1 font-mono text-sm text-text">{helper.assignments.timedOut}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">Accept rate</dt>
            <dd className="mt-1 font-mono text-sm text-text">
              {helper.acceptRate === null
                ? "Not enough data"
                : `${percent(helper.acceptRate)} · ${helper.assignments.claimed}/${helper.assignments.completedOffers}`}
            </dd>
          </div>
        </dl>
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
