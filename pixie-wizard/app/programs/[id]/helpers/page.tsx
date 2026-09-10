import { requireProgramMembership } from "@/lib/programAccess";
import Link from "next/link";
import { listHostedHelpers } from "@/lib/hostedPrograms";
import { coreHelpers, coreRoutingRecommend, coreHelperStats, type CoreHelperStats } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError, EmptyState } from "@/app/_components/DashboardShell";
import { userLabel } from "@/app/_components/format";
import { HelperAddForm, HelperVisibilityToggle } from "./HelperForms";

type Helper = { user_id: string; helper_source: string; role: string; active: number };
type Recommendation = { userId: string; score: number; reasons: string[] };

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

  return (
    <>
      <PageHeader title="Helpers" description="Who can take a ticket, and what they're carrying." />

      {loadError && <CoreError message={loadError} />}
      {statsError && <CoreError message={statsError} />}

      <div className="space-y-12">
        <Section title={`Roster${roster.length ? ` · ${roster.length}` : ""}`}>
          {roster.length === 0 && !loadError ? (
            <EmptyState title="No helpers yet." hint="As creator you're the organizer. Add helpers below." />
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {roster.map((h) => (
                <li key={h.user_id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
                  <span className="min-w-0">
                  <Link className="font-mono text-brand underline" href={`/programs/${id}/helpers/${encodeURIComponent(h.user_id)}`}>{userLabel(h.user_id)}</Link>{" "}
                    <span className="font-mono text-xs text-text-muted">
                      {h.role}
                      {h.helper_source ? ` · via ${h.helper_source}` : ""}
                    </span>
                  </span>
                  <span className="font-mono text-xs tabular-nums text-text-muted">
                    {h.stats ? <><span className={h.stats.totals.open > 0 ? "text-tang" : ""}>{h.stats.totals.open}</span> open ·{" "}
                    <span className="text-mint">{h.stats.totals.resolved}</span> resolved · {h.stats.helpfulPercentage === null ? "-" : `${Math.round(h.stats.helpfulPercentage * 100)}%`} helpful</> : "stats unavailable"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {recs.length > 0 && (
          <Section title="Best matched" description="Ranked by expertise tags and recent resolutions.">
            <ul className="space-y-1.5 text-sm">
              {recs.map((r) => (
                <li key={r.userId} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-text">{userLabel(r.userId)}</span>
                  <span className="font-mono text-xs text-text-muted">score {r.score}</span>
                  <span className="text-xs text-text-muted">· {r.reasons.join("; ")}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {canManageVisibility && wizardHelpers.length > 0 && (
          <Section
            title="Public profile"
            description="Whether each helper appears on the public program roster. Never changes their permissions."
          >
            <div>
              {wizardHelpers.map((h) => (
                <HelperVisibilityToggle
                  key={h.slack_user_id}
                  programId={id}
                  slackUserId={h.slack_user_id}
                  role={h.role}
                  visible={h.visible_on_profile}
                />
              ))}
            </div>
          </Section>
        )}

        <HelperAddForm programId={id} />
      </div>
    </>
  );
}
