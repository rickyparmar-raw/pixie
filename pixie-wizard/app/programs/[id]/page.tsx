import { redirect } from "next/navigation";
import Link from "next/link";
import { getPublicProgramProfile, listVisibleHelperIdentityKeys } from "@/lib/hostedPrograms";
import { loadProgramContext } from "@/lib/programAccess";
import { PublicProfile } from "./PublicProfile";
import { coreAnalytics, coreSlackChannels, coreTicketSearch, coreKnowledgeCandidates, coreHelperStats } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import {
  Section,
  StatusBadge,
  CoreError,
  MiniBar,
  BarList,
  DataRow,
  EmptyState,
  StatCard,
} from "@/app/_components/DashboardShell";
import { personaName, timeAgo } from "@/app/_components/format";
import { IconChat, IconHand, IconCheck, IconClock, IconDoc, IconUsers } from "@/app/_components/icons";
import type { PublicHelperIdentity } from "@/lib/types";
import { QueuePanel } from "./QueuePanel";
import { getMyQueue } from "./queueActions";

function healthLabel(status: string, sync: string): string {
  if (sync === "pending") return "Sync pending";
  if (sync === "failed") return "Sync failed";
  if (status === "active") return "Healthy";
  return status;
}

function greetingWord(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

type Ticket = {
  id: number;
  question: string | null;
  summary: string | null;
  status: string;
  requester_id: string;
  assignee_id: string | null;
  created_at: number;
  resolved_at?: number | null;
};

const OPEN_STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
const ATTENTION_STATUSES = ["waiting_for_helper", "escalated", "reopened"];

// Ticket-state bars, in the order a request moves through them — resolved
// last, since it's where the pipeline ends. Included here (unlike the
// "needs attention" list) so the card reads as a full picture of the last
// 30 days instead of just the handful of states that happen to be nonzero.
const STATE_ORDER: Array<[key: string, label: string, tone: string]> = [
  ["waiting_for_helper", "Waiting for a helper", "bg-tang"],
  ["assigned", "Assigned", "bg-text-muted"],
  ["claimed", "Claimed", "bg-text-muted"],
  ["escalated", "Escalated", "bg-brand"],
  ["reopened", "Reopened", "bg-brand"],
  ["open", "Unanswered", "bg-text-muted"],
  ["resolved", "Resolved", "bg-mint"],
];

export default async function ProgramPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, program, relationship } = await loadProgramContext(id);
  if (!session) redirect("/");
  if (!program) redirect("/programs");

  // Non-member: safe read-only profile. getPublicProgramProfile() is a
  // column-allowlisted projection — there is no admin `program` object in
  // scope here to accidentally pass through.
  if (relationship === "public") {
    const profile = await getPublicProgramProfile(id);
    if (!profile) redirect("/programs");

    const [channelsRes, identityKeys] = await Promise.all([
      profile.publicHelpChannelId ? coreSlackChannels().catch(() => null) : Promise.resolve(null),
      listVisibleHelperIdentityKeys(id).catch(() => []),
    ]);

    let helpChannelDisplay: string | null = null;
    if (profile.publicHelpChannelId) {
      const match = channelsRes?.ok ? channelsRes.channels.find((c) => c.id === profile.publicHelpChannelId) : null;
      helpChannelDisplay = match ? `#${match.name}` : profile.publicHelpChannelId;
    }

    const rosterIdentities = await resolveIdentities(identityKeys.map((k) => k.slackUserId));
    const roster: PublicHelperIdentity[] = identityKeys.map(({ slackUserId, role }) => {
      const found = rosterIdentities.get(slackUserId);
      return { role, displayName: found?.displayName ?? found?.realName ?? null, avatarUrl: found?.avatarUrl ?? null };
    });

    return <PublicProfile profile={profile} helpChannelDisplay={helpChannelDisplay} roster={roster} />;
  }

  // Member overview reads degrade independently so one Core failure does not
  // block the shell or the other useful sections.
  const [analyticsR, ticketsR, candidatesR, helperStatsR, myQueue] = await Promise.allSettled([
    coreAnalytics(id, 30),
    coreTicketSearch({ programId: id, limit: "60" }),
    coreKnowledgeCandidates(id),
    coreHelperStats(id),
    getMyQueue(id),
  ]);

  const analytics = analyticsR.status === "fulfilled" ? (analyticsR.value as Record<string, unknown>) : null;
  const coreDown = analyticsR.status === "rejected";
  const initialQueue = myQueue.status === "fulfilled" ? myQueue.value : { assigned: [], claimable: [] };
  const byStatus = (analytics?.byStatus ?? {}) as Record<string, number>;
  const persona = personaName(program);

  const questions = Number(analytics?.created ?? 0);
  const answered = Number(analytics?.aiAnswered ?? 0);
  const resolved = Number(byStatus.resolved ?? 0);
  const openCount = OPEN_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
  const waitingCount = byStatus.waiting_for_helper ?? 0;
  const escalated = Number(byStatus.escalated ?? 0);
  const stateMax = Math.max(1, ...STATE_ORDER.map(([k]) => byStatus[k] ?? 0));

  const tickets = ticketsR.status === "fulfilled" ? ((ticketsR.value.rows ?? []) as Ticket[]) : [];
  const resolvedToday = typeof analytics?.resolvedToday === "number" ? analytics.resolvedToday : null;
  const attention = tickets
    .filter((t) => ATTENTION_STATUSES.includes(t.status) || (t.status === "open" && !t.assignee_id))
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, 5);

  const identities = await resolveIdentities([
    ...tickets.map((t) => t.requester_id),
    ...tickets.map((t) => t.assignee_id),
    ...attention.map((t) => t.requester_id),
    ...attention.map((t) => t.assignee_id),
  ]);

  const gapCount = Object.values((analytics?.gapCounts ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
  const sourceCount = Array.isArray(program.sources) ? program.sources.length : 0;
  const reviewCount = candidatesR.status === "fulfilled" ? candidatesR.value.length : null;

  const helperStats = helperStatsR.status === "fulfilled" ? helperStatsR.value : null;
  const activeHelperCount = helperStats ? helperStats.helpers.filter((h) => h.active).length : null;
  const helperResolvedCount = helperStats ? helperStats.helpers.reduce((sum, h) => sum + h.totals.resolved, 0) : null;
  const acceptRatePct = helperStats?.acceptRate != null ? Math.round(helperStats.acceptRate * 100) : null;

  const firstName = session.name?.trim().split(/\s+/)[0] || "there";
  const needsHand = analytics ? waitingCount + escalated : 0;
  const mascotLine = !analytics
    ? null
    : needsHand > 0
      ? `${needsHand} ${needsHand === 1 ? "ticket needs" : "tickets need"} a hand right now.`
      : "All quiet here! Your community is in good hands.";

  return (
    <>
      <div className="relative -mx-6 mb-10 overflow-hidden px-6 pb-8 lg:-mx-10 lg:px-10">
        <svg
          aria-hidden
          viewBox="0 0 320 240"
          className="pointer-events-none absolute -right-16 -top-16 hidden h-[240px] w-[320px] opacity-90 sm:block dark:opacity-70"
        >
          <path
            d="M303,86 C312,116 296,152 266,172 C236,192 190,196 154,186 C118,176 84,150 74,118 C64,86 78,48 108,28 C138,8 184,4 222,14 C260,24 294,56 303,86 Z"
            fill="var(--color-mint)"
          />
          <path
            d="M120,150 C138,142 160,146 168,164 C176,182 166,204 146,210 C126,216 102,208 94,190 C86,172 102,158 120,150 Z"
            fill="var(--color-brand)"
            opacity="0.9"
          />
        </svg>
        <div className="relative flex flex-wrap items-start justify-between gap-6 border-b border-line pb-8">
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium uppercase tracking-[0.16em] text-text-muted">
              <span>{greetingWord(new Date().getHours())}, {firstName}</span>
              <StatusBadge status={healthLabel(program.status, program.core_sync_state)} />
            </div>
            <h1 className="font-heading mt-2 max-w-lg text-[28px] font-semibold leading-[1.15] tracking-tight text-text sm:text-[34px]">
              Here&apos;s what&apos;s happening with {program.program_name}&apos;s support today.
            </h1>
            <p className="mt-2.5 max-w-md text-sm text-text-muted">
              {persona} keeps {program.program_name} moving with real answers, not more noise.
            </p>
          </div>
          {mascotLine && (
            <div className="flex items-start gap-3">
              <img src="/pixie-hero.png" alt="" width={48} height={48} className="pixel-art size-12 shrink-0" />
              <div className="relative max-w-[220px] rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px] leading-snug text-text shadow-[0_8px_20px_-10px_rgba(20,30,15,0.25)]">
                <span
                  aria-hidden
                  className="absolute -left-1.5 top-4 size-3 rotate-45 border-b border-l border-line bg-panel"
                />
                {mascotLine}
              </div>
            </div>
          )}
        </div>
      </div>

      {program.core_sync_state === "pending" && (
        <p className="mb-8 border-l-2 border-line pl-3 text-sm text-text-muted">
          Activation saved. Pixie picks up this configuration within a few minutes.
        </p>
      )}
      {program.core_sync_state === "failed" && program.core_sync_error && (
        <p className="mb-8 border-l-2 border-brand/60 pl-3 text-sm text-text-muted">
          {program.core_sync_error}. Settings are saved and retry automatically.
        </p>
      )}

      <div className="space-y-11">
        {coreDown && <CoreError message="Some support metrics are unavailable right now." />}
        {(!coreDown || ticketsR.status === "fulfilled") && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Open tickets" value={analytics ? openCount : "—"} icon={<IconChat size={14} />} barTone="bg-text-muted/30" />
            <StatCard label="Waiting for a helper" value={analytics ? waitingCount : "—"} icon={<IconHand size={14} />} tone="text-tang" iconTone="bg-tang/15" barTone="bg-tang" />
            <StatCard label="Resolved today" value={resolvedToday ?? "—"} icon={<IconCheck size={14} />} tone="text-mint" iconTone="bg-mint/15" barTone="bg-mint" />
            <StatCard label="Stayed quiet" value={analytics ? Number(analytics.stale48h ?? 0) : "—"} detail="open 48h+" icon={<IconClock size={14} />} tone="text-brand" iconTone="bg-brand/15" barTone="bg-brand" />
          </div>
        )}

        <QueuePanel programId={id} initial={initialQueue} hasSlack={Boolean(session.slackId)} />

        <div className="grid items-start gap-6 lg:grid-cols-[1.55fr_1fr]">
          <Section
            bordered
            title="Support activity"
            description="Ticket states across the last 30 days."
            actions={<Link href={`/programs/${id}/analytics`} className="text-xs text-text-muted hover:text-text">Analytics →</Link>}
          >
            {analyticsR.status === "rejected" ? <p className="text-sm text-text-muted">Support activity is unavailable right now.</p> : <>
              <div className="mb-6 flex flex-wrap gap-x-8 gap-y-2 text-xs text-text-muted">
                <span><span className="font-mono text-text">{questions}</span> questions</span>
                <span><span className="font-mono text-brand">{answered}</span> answered by {persona}</span>
                <span><span className="font-mono text-mint">{resolved}</span> resolved</span>
              </div>
              <BarList>
                 {STATE_ORDER.filter(([k]) => (byStatus[k] ?? 0) > 0).map(([k, label, tone]) => (
                  <MiniBar key={k} label={label} value={byStatus[k] ?? 0} max={stateMax} tone={tone} />
                ))}
                {STATE_ORDER.every(([k]) => (byStatus[k] ?? 0) === 0) && (
                  <EmptyState title="No tickets in the last 30 days." />
                )}
              </BarList>
            </>}
          </Section>

          <Section
            bordered
            title="Needs attention"
            actions={<Link href={`/programs/${id}/tickets`} className="text-xs text-text-muted hover:text-text">Tickets →</Link>}
          >
            {ticketsR.status === "rejected" ? (
              <p className="text-sm text-text-muted">Ticket queue is unavailable right now.</p>
            ) : attention.length === 0 ? (
              <EmptyState title="Nothing needs a person right now." hint="Waiting, escalated and reopened tickets show up here." />
            ) : (
              <ul className="divide-y divide-line">
                {attention.map((t) => (
                  <li key={t.id}>
                    <DataRow
                      href={`/programs/${id}/tickets/${t.id}`}
                      lead={`#${t.id}`}
                      title={t.summary || t.question || "Ticket"}
                      sub={
                        <span>
                          {statusShort(t.status)} · {labelFor(identities, t.requester_id)} · {timeAgo(t.created_at)}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <Section
          bordered
          title="Recent activity"
          actions={<Link href={`/programs/${id}/tickets`} className="text-xs text-text-muted hover:text-text">All tickets →</Link>}
        >
          {ticketsR.status === "rejected" ? (
            <p className="text-sm text-text-muted">Recent tickets are unavailable right now.</p>
          ) : tickets.length === 0 ? (
            <EmptyState title="No tickets yet." />
          ) : (
            <ul className="divide-y divide-line">
              {tickets.slice(0, 8).map((t) => {
                const isResolved = t.status === "resolved";
                const needsPerson = ATTENTION_STATUSES.includes(t.status);
                return (
                  <li key={t.id}>
                    <DataRow
                      href={`/programs/${id}/tickets/${t.id}`}
                      lead={
                        <span className={`grid size-5 place-items-center rounded-full ${isResolved ? "bg-mint/15 text-mint" : needsPerson ? "bg-tang/15 text-tang" : "bg-panel-2 text-text-muted"}`}>
                          {isResolved ? <IconCheck size={11} /> : needsPerson ? <IconHand size={11} /> : <IconChat size={11} />}
                        </span>
                      }
                      title={t.summary || t.question || "Ticket"}
                      sub={<span>{statusShort(t.status)} · {labelFor(identities, t.requester_id)}</span>}
                      meta={timeAgo(t.resolved_at ?? t.created_at)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <div className="grid gap-6 sm:grid-cols-2">
          <Section bordered title="Knowledge" actions={<Link href={`/programs/${id}/knowledge`} className="text-xs text-text-muted hover:text-text">Knowledge →</Link>}>
            <div className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-panel-2 text-text-muted"><IconDoc size={16} /></span>
              <div className="grid flex-1 grid-cols-3 gap-2 text-center">
                <div><p className="font-heading text-lg font-semibold text-text tabular-nums">{sourceCount}</p><p className="text-[11px] text-text-muted">Sources</p></div>
                <div><p className={`font-heading text-lg font-semibold tabular-nums ${gapCount ? "text-tang" : "text-text"}`}>{gapCount}</p><p className="text-[11px] text-text-muted">Open gaps</p></div>
                <div><p className={`font-heading text-lg font-semibold tabular-nums ${reviewCount ? "text-tang" : "text-text"}`}>{reviewCount ?? "—"}</p><p className="text-[11px] text-text-muted">In review</p></div>
              </div>
            </div>
          </Section>

          <Section bordered title="Helpers" actions={<Link href={`/programs/${id}/helpers`} className="text-xs text-text-muted hover:text-text">Helpers →</Link>}>
            {helperStatsR.status === "rejected" ? (
              <p className="text-sm text-text-muted">Helper stats are unavailable right now.</p>
            ) : (
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-panel-2 text-text-muted"><IconUsers size={16} /></span>
                <div className="grid flex-1 grid-cols-3 gap-2 text-center">
                  <div><p className="font-heading text-lg font-semibold text-text tabular-nums">{activeHelperCount ?? "—"}</p><p className="text-[11px] text-text-muted">Active</p></div>
                  <div><p className="font-heading text-lg font-semibold text-mint tabular-nums">{helperResolvedCount ?? "—"}</p><p className="text-[11px] text-text-muted">Resolved</p></div>
                  <div><p className="font-heading text-lg font-semibold text-text tabular-nums">{acceptRatePct != null ? `${acceptRatePct}%` : "—"}</p><p className="text-[11px] text-text-muted">Accept rate</p></div>
                </div>
              </div>
            )}
          </Section>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-5 text-xs text-text-muted">
          <span>Source health</span><span>{sourceCount} sources configured</span><span>{gapCount} open knowledge gaps</span>
          <Link href={`/programs/${id}/settings`} className="ml-auto text-text hover:text-brand">Settings →</Link>
        </div>
      </div>
    </>
  );
}

function statusShort(s: string): string {
  return s.replace(/_/g, " ");
}
