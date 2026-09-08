import { redirect } from "next/navigation";
import Link from "next/link";
import { getPublicProgramProfile, listVisibleHelperIdentityKeys } from "@/lib/hostedPrograms";
import { loadProgramContext } from "@/lib/programAccess";
import { PublicProfile } from "./PublicProfile";
import { coreAnalytics, coreSlackChannels, coreUserInfo, coreTicketSearch, coreAudit } from "@/lib/pixieCore";
import {
  PageHeader,
  Section,
  StatusBadge,
  CoreError,
  SignalRail,
  MiniBar,
  BarList,
  DataRow,
  EmptyState,
} from "@/app/_components/DashboardShell";
import { personaName, formatDuration, timeAgo } from "@/app/_components/format";
import type { PublicHelperIdentity } from "@/lib/types";

function healthLabel(status: string, sync: string): string {
  if (sync === "pending") return "Sync pending";
  if (sync === "failed") return "Sync failed";
  if (status === "active") return "Healthy";
  return status;
}

type Ticket = {
  id: number;
  question: string | null;
  summary: string | null;
  status: string;
  assignee_id: string | null;
  created_at: number;
};

type AuditEvent = {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: number;
};

const OPEN_STATUSES = ["open", "ai_answered", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
const ATTENTION_STATUSES = ["waiting_for_helper", "escalated", "reopened"];

// Ticket-state bars, in the order a request moves through them.
const STATE_ORDER: Array<[key: string, label: string, tone: string]> = [
  ["ai_answered", "Answered", "bg-mint"],
  ["waiting_for_helper", "Waiting for a helper", "bg-tang"],
  ["assigned", "Assigned", "bg-text-muted"],
  ["claimed", "Claimed", "bg-text-muted"],
  ["escalated", "Escalated", "bg-brand"],
  ["reopened", "Reopened", "bg-brand"],
  ["open", "Unanswered", "bg-text-muted"],
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

    const roster: PublicHelperIdentity[] = (
      await Promise.allSettled(
        identityKeys.map(async ({ slackUserId, role }) => {
          try {
            const info = await coreUserInfo(slackUserId);
            return { role, displayName: info.ok ? info.displayName ?? null : null, avatarUrl: info.ok ? info.avatarUrl ?? null : null };
          } catch {
            return { role, displayName: null, avatarUrl: null };
          }
        }),
      )
    ).map((r, i) => (r.status === "fulfilled" ? r.value : { role: identityKeys[i].role, displayName: null, avatarUrl: null }));

    return <PublicProfile profile={profile} helpChannelDisplay={helpChannelDisplay} roster={roster} />;
  }

  // Member overview. Three Core reads, all in parallel, all degrade on their
  // own — none blocks the shell, and any one failing leaves the rest of the
  // page intact. Configuration lives in Settings.
  const [analyticsR, ticketsR, auditR] = await Promise.allSettled([
    coreAnalytics(id, 30),
    coreTicketSearch({ programId: id, limit: "60" }),
    coreAudit(id),
  ]);

  const analytics = analyticsR.status === "fulfilled" ? (analyticsR.value as Record<string, unknown>) : null;
  const coreDown = analyticsR.status === "rejected";
  const byStatus = (analytics?.byStatus ?? {}) as Record<string, number>;
  const persona = personaName(program);

  const questions = Number(analytics?.created ?? 0);
  const answered = Number(analytics?.aiAnswered ?? 0);
  const escalated = Number(byStatus.escalated ?? 0);
  const resolved = Number(byStatus.resolved ?? 0);
  const openCount = OPEN_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
  const stateMax = Math.max(1, ...STATE_ORDER.map(([k]) => byStatus[k] ?? 0));

  const tickets = ticketsR.status === "fulfilled" ? ((ticketsR.value.rows ?? []) as Ticket[]) : [];
  const attention = tickets
    .filter((t) => ATTENTION_STATUSES.includes(t.status) || (t.status === "open" && !t.assignee_id))
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, 5);

  const events =
    auditR.status === "fulfilled"
      ? ((auditR.value ?? []) as AuditEvent[]).sort((a, b) => b.created_at - a.created_at).slice(0, 8)
      : [];

  const gapCount = Object.values((analytics?.gapCounts ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
  const sourceCount = Array.isArray(program.sources) ? program.sources.length : 0;

  return (
    <>
      <PageHeader
        title={program.program_name}
        description="Support activity, and anything that needs attention."
        actions={<StatusBadge status={healthLabel(program.status, program.core_sync_state)} />}
      />

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

      {coreDown ? (
        <CoreError message="Support metrics are unavailable right now." />
      ) : (
        <div className="space-y-11">
          {/* compact metric strip */}
          <div className="flex flex-wrap gap-x-10 gap-y-5">
            <Metric label="Open tickets" value={openCount} />
            <Metric label="Needs attention" value={attention.length} tone={attention.length ? "text-brand" : "text-text"} />
            <Metric label="Median first reply" value={formatDuration(analytics?.medianFirstResponseMs)} />
            <Metric label="Resolved · 30d" value={resolved} tone="text-mint" />
          </div>

          {/* primary: the support signal + what needs a person */}
          <div className="grid gap-10 lg:grid-cols-[1.35fr_1fr]">
            <Section
              title="Support pulse"
              description="Last 30 days."
              actions={<Link href={`/programs/${id}/analytics`} className="text-xs text-text-muted hover:text-text">Analytics →</Link>}
            >
              <SignalRail
                stages={[
                  { label: "Questions", value: questions },
                  { label: `${persona} answered`, value: answered, sub: pct(answered, questions) },
                  { label: "Escalated", value: escalated, tone: "text-brand", sub: pct(escalated, questions) },
                  { label: "Resolved", value: resolved, tone: "text-mint" },
                ]}
              />
              <p className="mt-5 text-xs text-text-muted">
                {answered} of {questions} answered without a person.{" "}
                {Number(analytics?.humanHandled ?? 0)} needed one.
              </p>
            </Section>

            <Section
              title="Needs attention"
              actions={<Link href={`/programs/${id}/tickets`} className="text-xs text-text-muted hover:text-text">Tickets →</Link>}
            >
              {ticketsR.status === "rejected" ? (
                <p className="text-sm text-text-muted">Ticket queue is unavailable right now.</p>
              ) : attention.length === 0 ? (
                <EmptyState title="Nothing needs a person right now." hint="Waiting, escalated and reopened tickets show up here." />
              ) : (
                <ul className="divide-y divide-line border-t border-line">
                  {attention.map((t) => (
                    <li key={t.id}>
                      <DataRow
                        href={`/programs/${id}/tickets/${t.id}`}
                        lead={`#${t.id}`}
                        title={t.summary || t.question || "Ticket"}
                        sub={<span className="font-mono">{statusShort(t.status)} · {timeAgo(t.created_at)}</span>}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          {/* secondary: state + knowledge */}
          <div className="grid gap-10 sm:grid-cols-2">
            <Section title="Ticket state">
              <BarList>
                {STATE_ORDER.filter(([k]) => (byStatus[k] ?? 0) > 0).map(([k, label, tone]) => (
                  <MiniBar key={k} label={label} value={byStatus[k] ?? 0} max={stateMax} tone={tone} />
                ))}
                {STATE_ORDER.every(([k]) => (byStatus[k] ?? 0) === 0) && (
                  <EmptyState title="No tickets in the last 30 days." />
                )}
              </BarList>
            </Section>

            <Section
              title="Knowledge"
              actions={<Link href={`/programs/${id}/knowledge`} className="text-xs text-text-muted hover:text-text">Knowledge →</Link>}
            >
              <div className="space-y-1">
                <KRow label="Sources" value={sourceCount} />
                <KRow label="Open gaps" value={gapCount} tone={gapCount ? "text-tang" : "text-text"} />
                <KRow label="Reopen rate" value={`${Math.round(Number(analytics?.reopenRate ?? 0) * 100)}%`} />
                <KRow label="Deflection" value={`${Math.round(Number(analytics?.deflectionRate ?? 0) * 100)}%`} />
              </div>
            </Section>
          </div>

          {/* tertiary: what happened */}
          <Section
            title="Recent activity"
            actions={<Link href={`/programs/${id}/audit`} className="text-xs text-text-muted hover:text-text">Audit →</Link>}
          >
            {auditR.status === "rejected" ? (
              <p className="text-sm text-text-muted">Activity is unavailable right now.</p>
            ) : events.length === 0 ? (
              <EmptyState title="No activity yet." />
            ) : (
              <ul className="divide-y divide-line border-t border-line text-sm">
                {events.map((e) => {
                  const a = activityLine(e, persona);
                  return (
                    <li key={e.id} className="flex items-baseline gap-3 py-2">
                      <span className="w-10 shrink-0 font-mono text-xs text-text-muted">{timeAgo(e.created_at)}</span>
                      <span className="min-w-0 flex-1 truncate text-text">
                        {a.ref && <span className="font-mono text-text-muted">{a.ref} </span>}
                        {a.verb}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-text-muted">{a.who}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <p className="border-t border-line pt-6 text-sm text-text-muted">
            Behavior, knowledge sources and channels are in{" "}
            <Link href={`/programs/${id}/settings`} className="text-text hover:text-brand">Settings</Link>.
          </p>
        </div>
      )}
    </>
  );
}

/* -- local presentational bits ------------------------------------------- */

function Metric({ label, value, tone = "text-text" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div>
      <p className={`font-mono text-2xl tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-xs text-text-muted">{label}</p>
    </div>
  );
}

function KRow({ label, value, tone = "text-text" }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className={`font-mono tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

function pct(n: number, d: number): string | undefined {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : undefined;
}

function statusShort(s: string): string {
  return s.replace(/_/g, " ");
}

// Turn a Core audit row into a ledger line: a ticket/entity ref, a plain
// verb, and who did it. Never throws on an unfamiliar shape.
function activityLine(e: AuditEvent, persona: string): { ref: string; verb: string; who: string } {
  const ref = e.entity_type === "ticket" && e.entity_id ? `#${e.entity_id}` : "";
  const verb = e.action
    .replace(/^[a-z]+\./, "")
    .replace(/^ai[_ ]/, "")
    .replace(/[._]/g, " ")
    .trim();
  const who = e.actor_id ?? persona;
  return { ref, verb, who };
}
