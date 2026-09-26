import { requireProgramMembership } from "@/lib/programAccess";
import Link from "next/link";
import { listHostedHelpers } from "@/lib/hostedPrograms";
import { coreHelpers, coreRoutingRecommend, coreHelperStats, type CoreHelperStats } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import {
  BarList,
  Chip,
  CoreError,
  EmptyState,
  MiniBar,
  PageHeader,
  Section,
  StatCard,
} from "@/app/_components/DashboardShell";
import { IconCheck, IconGauge, IconHourglass, IconUsers } from "@/app/_components/icons";
import { HelperAddForm, HelperVisibilityToggle } from "./HelperForms";

type Helper = { user_id: string; helper_source: string; role: string; active: number };
type Recommendation = { userId: string; score: number; reasons: string[] };

// The onboarding's Helpers step states these two out loud next to the tag
// picker. The dashboard says them too, so routing reads the same on both
// surfaces instead of only being explained once, at setup.
const ROUTING_RULES = [
  "A helper with no tags is still used when nothing matches.",
  "Tags, people, and channels can all change after launch.",
];

// The onboarding's person tile: a 1px outlined square holding either a real
// Slack avatar (pixelated, so a photo can never soften the world) or the
// person's initial in the pixel face.
function HelperAvatar({ label, avatarUrl }: { label: string; avatarUrl: string | null }) {
  const initial = (label.startsWith("@") ? label.slice(1) : label).slice(0, 1).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-[2px] border border-line-strong bg-panel-2 font-display text-[14px] leading-none text-text"
    >
      {avatarUrl ? <img src={avatarUrl} alt="" className="pixel-art size-full object-cover" /> : initial}
    </span>
  );
}

export default async function HelpersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { relationship } = await requireProgramMembership(id);
  const canManageVisibility = relationship === "owner" || relationship === "admin";

  const [wizardHelpers, coreR] = await Promise.all([
    canManageVisibility ? listHostedHelpers(id).catch(() => []) : Promise.resolve([]),
    Promise.allSettled([
      coreHelpers(id) as Promise<Helper[]>,
      coreRoutingRecommend(id) as Promise<Recommendation[]>,
      coreHelperStats(id),
    ]),
  ]);
  const [helpersR, recsR, analyticsR] = coreR;

  const loadError =
    helpersR.status === "rejected"
      ? helpersR.reason instanceof Error
        ? helpersR.reason.message
        : "The helper roster is unavailable."
      : null;
  const statsError = analyticsR.status === "rejected"
    ? analyticsR.reason instanceof Error ? analyticsR.reason.message : "Helper stats are unavailable."
    : null;

  const helpers = helpersR.status === "fulfilled" ? helpersR.value.filter((h) => h.active) : [];
  const recs = recsR.status === "fulfilled" ? recsR.value : [];
  const stats = analyticsR.status === "fulfilled" ? analyticsR.value : null;
  const statById = new Map<string, CoreHelperStats["helpers"][number]>(stats?.helpers.map((helper) => [helper.userId, helper]) ?? []);

  const roster = helpers
    .map((h) => ({ ...h, stats: statById.get(h.user_id) }))
    .sort((a, b) => (b.stats?.totals.resolved ?? 0) - (a.stats?.totals.resolved ?? 0));

  const identities = await resolveIdentities([
    ...roster.map((h) => h.user_id),
    ...recs.map((r) => r.userId),
  ]);

  // Headline figures are printed only when every roster row carries stats: a row
  // without them would otherwise be summed in as a zero, which is a number Pixie
  // does not have. The per-row "stats unavailable" is the honest fallback.
  const complete = stats !== null && roster.every((h) => h.stats);
  const openTotal = complete ? roster.reduce((n, h) => n + (h.stats?.totals.open ?? 0), 0) : null;
  const resolvedTotal = complete ? roster.reduce((n, h) => n + (h.stats?.totals.resolved ?? 0), 0) : null;
  const helpfulRates = complete
    ? roster.map((h) => h.stats?.helpfulPercentage ?? null).filter((v): v is number => v !== null)
    : [];
  const helpfulLabel = helpfulRates.length
    ? `${Math.round((helpfulRates.reduce((a, b) => a + b, 0) / helpfulRates.length) * 100)}%`
    : "—";
  const helpfulDetail = !complete
    ? "stats unavailable"
    : helpfulRates.length
      ? "roster average of feedback"
      : "no feedback recorded";
  // Bars are share-of-best, so a score outside 0-1 can never overflow a track.
  const recMax = Math.max(...recs.map((r) => r.score), Number.EPSILON);

  return (
    <>
      <PageHeader title="Helpers" description="Who can take a ticket, and what they're carrying." />

      {loadError && <CoreError message={loadError} />}
      {statsError && <CoreError message={statsError} />}

      <div className="space-y-8">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="On the roster"
            value={roster.length}
            detail={roster.length === 1 ? "helper can take a ticket" : "helpers can take a ticket"}
            icon={<IconUsers size={16} />}
          />
          <StatCard
            label="Open load"
            value={openTotal ?? "—"}
            detail={openTotal === null ? "stats unavailable" : "tickets waiting on a helper"}
            icon={<IconHourglass size={16} />}
            tone="text-tang"
            iconTone="bg-tang/10"
          />
          <StatCard
            label="Resolved"
            value={resolvedTotal ?? "—"}
            detail={resolvedTotal === null ? "stats unavailable" : "tickets closed by this roster"}
            icon={<IconCheck size={16} />}
            tone="text-mint"
            iconTone="bg-mint/10"
          />
          <StatCard
            label="Helpful"
            value={helpfulLabel}
            detail={helpfulDetail}
            icon={<IconGauge size={16} />}
          />
        </div>

        <Section
          title={`Roster${roster.length ? ` · ${roster.length}` : ""}`}
          description="Everyone Pixie can hand a ticket to in this program."
        >
          {roster.length === 0 && !loadError ? (
            <EmptyState
              title="No helpers yet."
              hint="You're the organizer of this program. Add a helper below and Pixie can hand questions over."
            />
          ) : (
            <ul className="pixie-panel divide-y divide-line">
              {roster.map((h) => {
                const label = labelFor(identities, h.user_id);
                const identity = identities.get(h.user_id);
                // When Core knows nobody the label IS "@<id>", so the id line
                // drops instead of printing the same string twice.
                const named = label !== `@${h.user_id}`;
                // Strongest tag first, so the lime chip is the one that earned it.
                const tags = [...(h.stats?.expertise ?? [])].sort((a, b) => b.solved_count - a.solved_count);
                return (
                  <li key={h.user_id}>
                    <Link
                      href={`/programs/${id}/helpers/${encodeURIComponent(h.user_id)}`}
                      prefetch={false}
                      className="group block px-4 py-3 transition-colors hover:bg-panel-2"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <HelperAvatar label={label} avatarUrl={identity?.avatarUrl ?? null} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-text transition-colors group-hover:text-brand">
                            {label}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                            {named && <span className="font-mono text-xs text-text-muted">@{h.user_id}</span>}
                            <Chip>{h.role}</Chip>
                            {h.helper_source && (
                              <span className="font-mono text-xs text-text-muted">via {h.helper_source}</span>
                            )}
                          </span>
                        </span>
                        {h.stats ? (
                          // Three fixed columns, not a flex run: the open /
                          // resolved / helpful figures then line up down the
                          // whole roster instead of drifting with each row's
                          // digit count.
                          <span className="ml-auto grid w-full shrink-0 grid-cols-[3.75rem_5.75rem_minmax(0,1fr)] items-baseline gap-x-3 font-mono text-[12px] sm:w-auto">
                            <span className={`text-right ${h.stats.totals.open > 0 ? "text-tang" : "text-text-muted"}`}>
                              {h.stats.totals.open} open
                            </span>
                            <span className={`text-right ${h.stats.totals.resolved > 0 ? "text-mint" : "text-text-muted"}`}>
                              {h.stats.totals.resolved} resolved
                            </span>
                            <span className="truncate text-right text-text-muted">
                              {h.stats.helpfulPercentage === null
                                ? "no feedback yet"
                                : `${Math.round(h.stats.helpfulPercentage * 100)}% helpful`}
                            </span>
                          </span>
                        ) : (
                          <span className="ml-auto w-full shrink-0 text-xs text-text-muted sm:w-auto">stats unavailable</span>
                        )}
                      </div>
                      {tags.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 sm:ml-10">
                          {tags.map((tag, index) => (
                            <Chip key={tag.tag} tone={index === 0 ? "lime" : undefined}>
                              {tag.tag}
                            </Chip>
                          ))}
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {recs.length > 0 && (
          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            <Section title="Best matched" description="Ranked by expertise tags and recent resolutions." bordered>
              <BarList>
                {recs.map((r) => (
                  <div key={r.userId} className="border-b border-line pb-2 last:border-0 last:pb-0">
                    <MiniBar
                      label={labelFor(identities, r.userId)}
                      value={r.score}
                      max={recMax}
                      tone="bg-brand"
                      display={r.score.toFixed(2)}
                    />
                    {/* 8.5rem of label plus MiniBar's 0.75rem gutter: the reason
                        line starts exactly under its own bar. */}
                    <p className="mt-1.5 text-[12px] text-text-muted sm:pl-[9.25rem]">{r.reasons.join("; ")}</p>
                  </div>
                ))}
              </BarList>
            </Section>

            <Section
              title="How routing works"
              description="Pixie reads the question, picks the closest tag, and hands it to whoever has that tag."
              bordered
            >
              <ul className="space-y-2">
                {ROUTING_RULES.map((rule) => (
                  <li key={rule} className="flex items-start gap-2.5 text-[13px] text-text-muted">
                    <span className="pixie-mark mt-[6px]" aria-hidden />
                    {rule}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}

        {canManageVisibility && wizardHelpers.length > 0 && (
          <Section
            title="Public profile"
            description="Whether each helper appears on the public program roster. Never changes their permissions."
            bordered
          >
            <div className="divide-y divide-line">
              {wizardHelpers.map((h) => (
                <HelperVisibilityToggle
                  key={h.slack_user_id}
                  programId={id}
                  slackUserId={h.slack_user_id}
                  label={labelFor(identities, h.slack_user_id)}
                  role={h.role}
                  visible={h.visible_on_profile}
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Add helper" description="Tags route matching questions. A helper with no tags is still used as a fallback." bordered>
          <HelperAddForm programId={id} />
        </Section>
      </div>
    </>
  );
}
