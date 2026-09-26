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
  Notice,
} from "@/app/_components/DashboardShell";
import { personaName, timeAgo } from "@/app/_components/format";
import {
  IconChat,
  IconHand,
  IconCheck,
  IconClock,
  IconDoc,
  IconUsers,
  IconArrowRight,
} from "@/app/_components/icons";
import type { PublicHelperIdentity } from "@/lib/types";
import type { VolumeDay } from "@/lib/dashboardMetrics";
import { VolumeChart } from "@/app/_components/charts/VolumeChart";
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
  ["escalated", "Escalated", "bg-tang"],
  ["reopened", "Reopened", "bg-tang"],
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
  const daily = (analytics?.daily ?? []) as VolumeDay[];
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
      <ProgramHero
        greeting={`${greetingWord(new Date().getHours())}, ${firstName}`}
        health={healthLabel(program.status, program.core_sync_state)}
        title={`Here's what's happening with ${program.program_name}'s support today.`}
        lede={`${persona} keeps ${program.program_name} moving with real answers, not more noise.`}
        mascotLine={mascotLine}
      />

      {/* Sync state is an honest warning, never a silent gap: pending is
          information, failed is a failure. */}
      {program.core_sync_state === "pending" && (
        <div className="mb-8">
          <Notice tone="info">Activation saved. Pixie picks up this configuration within a few minutes.</Notice>
        </div>
      )}
      {program.core_sync_state === "failed" && program.core_sync_error && (
        <div className="mb-8">
          <Notice tone="error">
            {program.core_sync_error}. Settings are saved and retry automatically.
          </Notice>
        </div>
      )}

      <div className="space-y-8">
        {coreDown && <CoreError message="Some support metrics are unavailable right now." />}
        {(!coreDown || ticketsR.status === "fulfilled") && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Open tickets" value={analytics ? openCount : "—"} icon={<IconChat size={16} />} />
            <StatCard
              label="Waiting for a helper"
              value={analytics ? waitingCount : "—"}
              icon={<IconHand size={16} />}
              tone="text-tang"
              iconTone="bg-tang/15"
            />
            <StatCard
              label="Resolved today"
              value={resolvedToday ?? "—"}
              icon={<IconCheck size={16} />}
              tone="text-mint"
              iconTone="bg-mint/15"
            />
            {/* Stale is a failure state, so it wears danger — never lime. */}
            <StatCard
              label="Stayed quiet"
              value={analytics ? Number(analytics.stale48h ?? 0) : "—"}
              detail="open 48h+"
              icon={<IconClock size={16} />}
              tone="text-danger"
              iconTone="bg-danger/15"
            />
          </div>
        )}

        <QueuePanel programId={id} initial={initialQueue} hasSlack={Boolean(session.slackId)} />

        {analyticsR.status === "fulfilled" && (
          <Section bordered title="Question volume" description="Last 30 days, by the day each question arrived.">
            <VolumeChart data={daily} aspectRatio="4 / 1" />
          </Section>
        )}

        {/* minmax(0,…) on both tracks: the ticket lists inside carry
            nowrap text, whose min-content would otherwise size the track and
            push the row past the viewport on a phone. */}
        <div className="grid items-start gap-6 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <Section
            bordered
            title="Support activity"
            description="Ticket states across the last 30 days."
            actions={<PanelLink href={`/programs/${id}/analytics`}>Analytics</PanelLink>}
          >
            {analyticsR.status === "rejected" ? (
              <Notice tone="warn">Support activity is unavailable right now.</Notice>
            ) : (
              <>
                <div className="mb-5 flex flex-wrap gap-x-8 gap-y-2 text-[12px] text-text-muted">
                  <span>
                    <span className="font-mono tabular-nums text-text">{questions}</span> questions
                  </span>
                  <span>
                    <span className="font-mono tabular-nums text-brand">{answered}</span> answered by {persona}
                  </span>
                  <span>
                    <span className="font-mono tabular-nums text-mint">{resolved}</span> resolved
                  </span>
                </div>
                <BarList>
                  {STATE_ORDER.filter(([k]) => (byStatus[k] ?? 0) > 0).map(([k, label, tone]) => (
                    <MiniBar key={k} label={label} value={byStatus[k] ?? 0} max={stateMax} tone={tone} />
                  ))}
                  {STATE_ORDER.every(([k]) => (byStatus[k] ?? 0) === 0) && (
                    <EmptyState
                      title="No tickets in the last 30 days."
                      hint="Ticket states appear here once questions start arriving."
                    />
                  )}
                </BarList>
              </>
            )}
          </Section>

          <Section
            bordered
            title="Needs attention"
            actions={<PanelLink href={`/programs/${id}/tickets`}>Tickets</PanelLink>}
          >
            {ticketsR.status === "rejected" ? (
              <Notice tone="warn">Ticket queue is unavailable right now.</Notice>
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
          actions={<PanelLink href={`/programs/${id}/tickets`}>All tickets</PanelLink>}
        >
          {ticketsR.status === "rejected" ? (
            <Notice tone="warn">Recent tickets are unavailable right now.</Notice>
          ) : tickets.length === 0 ? (
            <EmptyState title="No tickets yet." hint="Every question your community asks shows up here." />
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
                        <span
                          className={`grid size-6 place-items-center rounded-[2px] ${
                            isResolved ? "bg-mint/15 text-mint" : needsPerson ? "bg-tang/15 text-tang" : "bg-panel-2 text-text-muted"
                          }`}
                        >
                          {isResolved ? <IconCheck size={16} /> : needsPerson ? <IconHand size={16} /> : <IconChat size={16} />}
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
          <Section
            bordered
            title="Knowledge"
            actions={<PanelLink href={`/programs/${id}/knowledge`}>Knowledge</PanelLink>}
          >
            <div className="flex items-center gap-4">
              <span className="grid size-8 shrink-0 place-items-center rounded-[2px] bg-panel-2 text-text-muted">
                <IconDoc size={16} />
              </span>
              <SummaryNumbers
                items={[
                  { value: sourceCount, label: "Sources" },
                  { value: gapCount, label: "Open gaps", tone: gapCount ? "text-tang" : undefined },
                  { value: reviewCount ?? "—", label: "In review", tone: reviewCount ? "text-tang" : undefined },
                ]}
              />
            </div>
          </Section>

          <Section bordered title="Helpers" actions={<PanelLink href={`/programs/${id}/helpers`}>Helpers</PanelLink>}>
            {helperStatsR.status === "rejected" ? (
              <Notice tone="warn">Helper stats are unavailable right now.</Notice>
            ) : (
              <div className="flex items-center gap-4">
                <span className="grid size-8 shrink-0 place-items-center rounded-[2px] bg-panel-2 text-text-muted">
                  <IconUsers size={16} />
                </span>
                <SummaryNumbers
                  items={[
                    { value: activeHelperCount ?? "—", label: "Active" },
                    { value: helperResolvedCount ?? "—", label: "Resolved", tone: "text-mint" },
                    { value: acceptRatePct != null ? `${acceptRatePct}%` : "—", label: "Accept rate" },
                  ]}
                />
              </div>
            )}
          </Section>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-5 text-[12px] text-text-muted">
          <p className="pixie-eyebrow flex items-center gap-2">
            <span className="pixie-mark" aria-hidden="true" />
            Source health
          </p>
          <p>
            <span className="font-mono tabular-nums text-text">{sourceCount}</span> sources configured
          </p>
          <p>
            <span className="font-mono tabular-nums text-text">{gapCount}</span> open knowledge gaps
          </p>
          <Link
            href={`/programs/${id}/settings`}
            className="pixie-button pixie-button-ghost pixie-button-sm ml-auto"
          >
            Settings
            <IconArrowRight size={16} />
          </Link>
        </div>
      </div>
    </>
  );
}

// The overview hero. Same recipe as PageHeader — eyebrow, pixel H1, muted
// lede, hairline under — but hand-rolled because this one row has to carry
// three things PageHeader's string eyebrow can't: the greeting, the program
// health badge beside it, and Pixie's status note on the right.
function ProgramHero({
  greeting,
  health,
  title,
  lede,
  mascotLine,
}: {
  greeting: string;
  health: string;
  title: string;
  lede: string;
  mascotLine: string | null;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-x-8 gap-y-5 border-b border-line pb-6">
      <div className="min-w-[16rem] flex-1">
        <p className="pixie-eyebrow flex flex-wrap items-center gap-x-3 gap-y-1.5 text-text-muted">
          <span className="flex items-center gap-2">
            <span className="pixie-mark" aria-hidden="true" />
            {greeting}
          </span>
          <StatusBadge status={health} />
        </p>
        <h1 className="mt-3 max-w-[34rem] font-display text-[26px] leading-[1.05] text-text sm:text-[34px]">{title}</h1>
        <p className="mt-3 max-w-[60ch] text-sm text-text-muted">{lede}</p>
      </div>
      {/* Pixie's own line, as a note in her voice — a bordered panel, square
          corners, no bubble tail. Absent when Core is down and she has
          nothing to report. */}
      {mascotLine && (
        <div className="flex w-full max-w-[21rem] items-start gap-2.5 rounded-[3px] border border-line bg-panel px-3 py-2.5 sm:w-auto">
          <img src="/pixie-hero.png" alt="" width={32} height={32} className="pixel-art size-8 shrink-0" />
          <p className="min-w-0 text-[13px] leading-snug text-text">{mascotLine}</p>
        </div>
      )}
    </div>
  );
}

// The one way a panel header points somewhere else: a ghost button with the
// pixel arrow, so every header row on this page reads the same.
function PanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="pixie-button pixie-button-ghost pixie-button-sm">
      {children}
      <IconArrowRight size={16} />
    </Link>
  );
}

// A three-figure summary for a panel: figures are operational, so mono, and
// only a figure that is asking for attention takes a tone.
function SummaryNumbers({
  items,
}: {
  items: { value: string | number; label: string; tone?: string }[];
}) {
  return (
    <div className="grid flex-1 grid-cols-3 gap-2 text-center">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <p className={`font-mono text-[19px] leading-none tabular-nums ${item.tone ?? "text-text"}`}>
            {item.value}
          </p>
          <p className="mt-1.5 truncate text-[11px] text-text-muted">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

function statusShort(s: string): string {
  return s.replace(/_/g, " ");
}
