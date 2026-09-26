import Link from "next/link";
import {
  DashboardShell,
  Section,
  StatCard,
  StatusBadge,
  EmptyState,
} from "@/app/_components/DashboardShell";
import { VolumeChart } from "@/app/_components/charts/VolumeChart";
import { SharePie } from "@/app/_components/charts/SharePie";
import { personaName } from "@/app/_components/format";
import { requireWizardSuperadmin } from "@/lib/programAccess";
import { listHostedProgramsForOwner } from "@/lib/hostedPrograms";
import { coreAnalytics } from "@/lib/pixieCore";
import { summarizeAnalytics, mergeDailySeries, OPEN_STATUSES, type AnalyticsSnapshot } from "@/lib/dashboardMetrics";
import {
  IconChat,
  IconCheck,
  IconGaps,
  IconHourglass,
  IconSiren,
  IconAlert,
  IconRadar,
} from "@/app/_components/icons";
import type { HostedProgramRow } from "@/lib/types";

function percent(value: number, total: number): string {
  return total ? `${Math.round((value / total) * 100)}%` : "0%";
}

// Stat tones, kept as pairs so the figure and its icon tile can never drift
// apart: mint for what worked, tang for what is waiting, danger for what broke.
const MINT = { tone: "text-mint", iconTone: "bg-mint/15" };
const TANG = { tone: "text-tang", iconTone: "bg-tang/15" };
const DANGER = { tone: "text-danger", iconTone: "bg-danger/15" };

// The state word for one program, in the order the failures win: a program
// whose configuration never reached Core is not healthy, whatever its status
// column says. A muted posture is how the product actually pauses a program,
// so it reads "Paused" — waiting, tang, never lime. Same rule as the directory
// card (app/programs/page.tsx); kept local so the page owns its own states.
function programState(program: HostedProgramRow): { label: string; error?: string | null } {
  if (program.core_sync_state === "failed") return { label: "Sync failed", error: program.core_sync_error };
  if (program.core_sync_state === "pending") return { label: "Sync pending" };
  if (program.status !== "active") return { label: program.status };
  if (program.posture === "muted" || !program.ai_answers) return { label: "Paused" };
  return { label: "Healthy" };
}

// Cross-program view — superadmin-only. Anyone else only ever needs the one
// program they actually work on; see requireWizardSuperadmin.
export default async function OverviewPage() {
  const session = await requireWizardSuperadmin();

  const programs = await listHostedProgramsForOwner(session).catch(() => []);
  const results = await Promise.all(programs.map(async (program) => {
    try { return { programId: program.id, snapshot: (await coreAnalytics(program.id, 30)) as unknown as AnalyticsSnapshot, error: null }; }
    catch (err) { return { programId: program.id, snapshot: null, error: err instanceof Error ? err.message : "Core unavailable" }; }
  }));
  const snapshots = results.flatMap((result) => result.snapshot ? [result.snapshot] : []);
  const unavailable = new Map(results.filter((result) => result.error).map((result) => [result.programId, result.error as string]));
  const totals = summarizeAnalytics(snapshots);
  const timeline = mergeDailySeries(snapshots);

  const nameFor = (programId: string) =>
    programs.find((program) => program.id === programId)?.program_name ?? programId;

  // Biggest first, so the lime slice is the biggest slice — the pie colours
  // follow position, and an unsorted list would hand lime to a rounding error.
  const volumeByProgram = snapshots
    .map((snapshot) => ({ label: nameFor(snapshot.programId), value: snapshot.created }))
    .sort((a, b) => b.value - a.value);

  // Disjoint by construction — the daily series splits each question by who
  // ended up answering it, so these three sum to the total. The top-level
  // aiAnswered/humanHandled counters overlap and cannot be used here.
  const pixieHandled = timeline.reduce((sum, day) => sum + day.aiOnly, 0);
  const neededPerson = timeline.reduce((sum, day) => sum + day.human, 0);
  const handling = [
    { label: "Pixie handled it", value: pixieHandled },
    { label: "Needed a person", value: neededPerson },
    { label: "No reply yet", value: Math.max(0, totals.questions - pixieHandled - neededPerson) },
  ];

  // What Pixie says about the whole workspace, in her own voice, and only ever
  // the honest version: a program that never reached Core outranks any volume.
  const desynced = programs.filter((program) => program.core_sync_state === "failed");
  const waitingOnSomeone = snapshots.reduce(
    (sum, snapshot) => sum + (snapshot.byStatus.waiting_for_helper ?? 0) + (snapshot.byStatus.escalated ?? 0),
    0,
  );
  const programWord = programs.length === 1 ? "program" : "programs";
  const mascotLine =
    programs.length === 0
      ? "No programs yet. New program sets the first one up."
      : desynced.length
        ? `${desynced.map((program) => program.program_name).join(", ")} never reached Core.`
        : waitingOnSomeone > 0
          ? `${waitingOnSomeone} ${waitingOnSomeone === 1 ? "ticket needs" : "tickets need"} a hand right now.`
          : `All quiet here! ${programs.length === 1 ? "Your program is" : "Your programs are"} in good hands.`;

  return (
    <DashboardShell crumb="Overview">
      {/* The program overview's hero, one row up: eyebrow + state, pixel
          sentence, muted lede, and Pixie's own note on the right. */}
      <div className="mb-8 flex flex-wrap items-start justify-between gap-x-8 gap-y-5 border-b border-line pb-6">
        <div className="min-w-[16rem] flex-1">
          <p className="pixie-eyebrow flex flex-wrap items-center gap-x-3 gap-y-1.5 text-text-muted">
            <span className="flex items-center gap-2">
              <span className="pixie-mark" aria-hidden="true" />
              Workspace
            </span>
            <StatusBadge status={`${programs.length} ${programWord}`} />
          </p>
          <h1 className="mt-3 max-w-[34rem] font-display text-[26px] leading-[1.05] text-text sm:text-[34px]">
            Here&apos;s what&apos;s happening across your programs.
          </h1>
          <p className="mt-3 max-w-[60ch] text-sm text-text-muted">
            Last 30 days across every program you own.
          </p>
        </div>
        <div className="flex w-full max-w-[21rem] items-start gap-2.5 rounded-[3px] border border-line bg-panel px-3 py-2.5 sm:w-auto">
          <img src="/pixie-hero.png" alt="" width={32} height={32} className="pixel-art size-8 shrink-0" />
          {/* The marker carries the tone, the way it does everywhere else: a
              program that never reached Core gets a danger square, not a
              paragraph of red. */}
          <p className="flex min-w-0 items-start gap-2 text-[13px] leading-snug text-text">
            {desynced.length > 0 && (
              <span aria-hidden className="mt-[6px] size-1.5 shrink-0 rounded-[1px] bg-danger" />
            )}
            <span className="min-w-0">{mascotLine}</span>
          </p>
        </div>
      </div>

      <div className="space-y-8">
        {/* One figure each, no figure twice: the workspace's whole picture in
            eight numbers, before a single chart. A figure of zero is a fact,
            not an alarm, so it stays cream on the plain tile. */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Questions" value={totals.questions} icon={<IconChat size={16} />} />
          <StatCard
            label="Answered by Pixie"
            value={totals.aiAnswered}
            detail={`${percent(totals.aiAnswered, totals.questions)} of questions`}
            icon={<IconCheck size={16} />}
            {...MINT}
          />
          <StatCard
            label="Open tickets"
            value={totals.openTickets}
            detail={`${totals.waitingTickets} waiting · ${totals.stale} stale 48h+`}
            icon={<IconHourglass size={16} />}
            {...(totals.openTickets ? TANG : {})}
          />
          <StatCard
            label="Escalated"
            value={totals.escalated}
            detail={`${percent(totals.escalated, totals.questions)} of questions`}
            icon={<IconSiren size={16} />}
            {...(totals.escalated ? TANG : {})}
          />
          <StatCard label="Resolved" value={totals.resolved} detail={totals.resolvedToday === null ? "today unavailable" : `${totals.resolvedToday} today`} icon={<IconCheck size={16} />} {...MINT} />
          <StatCard
            label="FAQ gaps"
            value={totals.faqGaps}
            icon={<IconGaps size={16} />}
            {...(totals.faqGaps ? TANG : {})}
          />
          <StatCard
            label="Active incidents"
            value={totals.activeIncidents}
            icon={<IconAlert size={16} />}
            {...(totals.activeIncidents ? DANGER : MINT)}
          />
          <StatCard
            label="Out of sync"
            value={desynced.length}
            detail={`of ${programs.length} ${programWord}`}
            icon={<IconRadar size={16} />}
            {...(desynced.length ? DANGER : MINT)}
          />
        </div>

        <Section
          bordered
          title="Question volume"
          description={`Every question across ${programs.length} ${programWord}, by the day it arrived.`}
        >
          <VolumeChart data={timeline} aspectRatio="4 / 1" />
        </Section>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Section bordered title="Where the questions came from" description="Share of volume by program.">
            <SharePie shares={volumeByProgram} centerLabel="Questions" unit="questions" />
          </Section>

          <Section bordered title="Who answered them" description="Each question counted once, by who replied first.">
            <SharePie shares={handling} centerLabel="Questions" unit="questions" />
          </Section>
        </div>

        <Section bordered title="By program" description="Each program's own 30-day numbers.">
          {programs.length === 0 ? (
            <EmptyState
              title="No hosted programs yet."
              hint="Once you launch a program it shows up here with its own 30-day numbers."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="pixie-table min-w-[600px]">
                <thead>
                  <tr>
                    <th>Program</th>
                    <th>Status</th>
                    <th className="text-right">Questions</th>
                    <th>AI answer rate</th>
                    <th className="text-right">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {programs.map((program) => {
                    const state = programState(program);
                    const row = snapshots.find((snapshot) => snapshot.programId === program.id);
                    const open = row
                      ? typeof row.openCount === "number"
                        ? row.openCount
                        : OPEN_STATUSES.reduce((sum, status) => sum + (row.byStatus[status] ?? 0), 0)
                      : null;
                    const rate = row && row.created ? row.aiAnswered / row.created : null;
                    return (
                      <tr key={program.id}>
                        <td>
                          {unavailable.has(program.id) && <span className="mb-1.5 block font-mono text-[11px] text-danger">Core unavailable</span>}
                          <Link
                            className="whitespace-nowrap text-text transition-colors hover:text-brand"
                            href={`/programs/${program.id}`}
                          >
                            {program.program_name}
                          </Link>
                          <span className="mt-0.5 block whitespace-nowrap text-[12px] text-text-muted">
                            {personaName(program)} answers
                          </span>
                        </td>
                        <td>
                          {/* Square marker, in the tone of the state itself — a
                              program that never reached Core is danger here,
                              never the mint of a healthy one. */}
                          <StatusBadge status={state.label} />
                          {state.error && (
                            <span className="mt-1.5 block max-w-[20rem] text-[11px] leading-relaxed text-danger">
                              {state.error}
                            </span>
                          )}
                        </td>
                        <td className="text-right font-mono tabular-nums text-text-muted">{row?.created ?? "—"}</td>
                        <td>
                          {rate === null ? (
                            <span className="text-text-muted">—</span>
                          ) : (
                            <span className="flex items-center gap-2.5">
                              {/* The bar carries the comparison down the column; the
                                  number stays for the exact read. */}
                              <span aria-hidden className="block h-1.5 w-16 bg-line/60">
                                <span className="block h-full rounded-[1px] bg-brand" style={{ width: `${Math.round(rate * 100)}%` }} />
                              </span>
                              <span className="font-mono text-xs tabular-nums text-text-muted">{Math.round(rate * 100)}%</span>
                            </span>
                          )}
                        </td>
                        <td className="text-right font-mono tabular-nums text-text-muted">{open ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </DashboardShell>
  );
}
