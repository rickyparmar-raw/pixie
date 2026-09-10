import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreHelperStats, coreUserInfo, coreConfigured, type CoreHelperStats } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";

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
  const identity = coreConfigured() ? await coreUserInfo(userId).catch(() => null) : null;
  const name = identity?.ok && identity.displayName ? identity.displayName : `@${userId}`;

  return <>
    <PageHeader title={name} description={`${helper.role} · program-scoped helper profile`} />
    <div className="space-y-10">
      <p><Link className="text-brand underline" href={`/programs/${id}/helpers`}>Back to helpers</Link></p>
      <Section title="Specialties" description="Observed resolutions are counted by category. Declared tags are shown separately.">
        <div className="space-y-2">
          {helper.categoryResolved.length ? helper.categoryResolved.map((entry) => <div key={entry.category} className="flex justify-between border-b border-line py-2 text-sm"><span>{entry.category}</span><span className="font-mono text-text-muted">{entry.resolved} resolutions</span></div>) : <p className="text-sm text-text-muted">No observed resolution data yet.</p>}
        </div>
        <p className="mt-4 text-xs text-text-muted">Declared tags: {helper.expertise.length ? helper.expertise.map((entry) => entry.tag).join(", ") : "none"}.</p>
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
