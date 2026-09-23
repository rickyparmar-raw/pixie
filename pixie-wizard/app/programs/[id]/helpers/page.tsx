import { requireProgramMembership } from "@/lib/programAccess";
import Link from "next/link";
import { listHostedHelpers } from "@/lib/hostedPrograms";
import { coreHelperRoster, coreRoutingRecommend, type DashboardHelperRosterEntry } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, Section, CoreError, EmptyState } from "@/app/_components/DashboardShell";
import { HelperAddForm, HelperVisibilityToggle, HelperAvailabilityToggle, HelperExpertiseForm } from "./HelperForms";

type Recommendation = { userId: string; score: number; reasons: string[] };

function categorySuggestions(categories: unknown): string[] {
  if (Array.isArray(categories)) return categories.filter((c): c is string => typeof c === "string");
  if (categories && typeof categories === "object") return Object.keys(categories);
  return [];
}

export default async function HelpersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { relationship } = await requireProgramMembership(id);
  const canManage = relationship === "owner" || relationship === "admin";

  const [wizardHelpers, rosterR, recsR] = await Promise.all([
    canManage ? listHostedHelpers(id).catch(() => []) : Promise.resolve([]),
    coreHelperRoster(id).then(
      (r) => ({ ok: true as const, value: r }),
      (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : "The helper roster is unavailable." }),
    ),
    coreRoutingRecommend(id).then(
      (value) => ({ ok: true as const, value: value as Recommendation[] }),
      () => ({ ok: false as const, value: [] as Recommendation[] }),
    ),
  ]);

  const loadError = !rosterR.ok ? rosterR.error : null;
  const roster: DashboardHelperRosterEntry[] = rosterR.ok ? rosterR.value.helpers : [];
  const categories = rosterR.ok ? categorySuggestions(rosterR.value.categories) : [];
  const recs = recsR.ok ? recsR.value : [];

  const identities = await resolveIdentities([
    ...roster.map((h) => h.userId),
    ...recs.map((r) => r.userId),
  ]);

  return (
    <>
      <PageHeader title="Helpers" description="Who can take a ticket, what they know, and what they're carrying." />

      {loadError && <CoreError message={loadError} />}

      <div className="space-y-12">
        <Section title={`Roster${roster.length ? ` · ${roster.length}` : ""}`}>
          {roster.length === 0 && !loadError ? (
            <EmptyState title="No helpers yet." hint="As creator you're the organizer. Add helpers below." />
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {roster.map((h) => (
                <li key={h.userId} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                    <span className="min-w-0">
                      <Link className="text-brand underline" href={`/programs/${id}/helpers/${encodeURIComponent(h.userId)}`}>{labelFor(identities, h.userId)}</Link>{" "}
                      <span className="font-mono text-xs text-text-muted">
                        {h.role}
                        {h.source ? ` · via ${h.source}` : ""}
                        {!h.active && " · paused"}
                      </span>
                    </span>
                    <span className="font-mono text-xs tabular-nums text-text-muted">
                      <span className={h.openAssigned > 0 ? "text-tang" : ""}>{h.openAssigned}</span> open ·{" "}
                      <span className="text-mint">{h.resolved}</span> solved · {h.helpfulPercentage === null ? "-" : `${Math.round(h.helpfulPercentage * 100)}%`} helpful
                    </span>
                  </div>
                  {(h.expertise.length > 0 || h.categoryResolved.length > 0) && (
                    <p className="text-xs text-text-muted">
                      {h.expertise.length > 0 && <>knows {h.expertise.map((e) => e.tag).join(", ")}</>}
                      {h.expertise.length > 0 && h.categoryResolved.length > 0 && " · "}
                      {h.categoryResolved.length > 0 && (
                        <>solved {h.categoryResolved.map((c) => `${c.category} (${c.resolved})`).join(", ")}</>
                      )}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <HelperExpertiseForm
                      programId={id}
                      slackUserId={h.userId}
                      tags={h.expertise.map((e) => e.tag)}
                      categorySuggestions={categories}
                    />
                    {canManage && (
                      <HelperAvailabilityToggle programId={id} slackUserId={h.userId} active={h.active} />
                    )}
                  </div>
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
                  <span className="text-text">{labelFor(identities, r.userId)}</span>
                  <span className="font-mono text-xs text-text-muted">score {r.score}</span>
                  <span className="text-xs text-text-muted">· {r.reasons.join("; ")}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {canManage && wizardHelpers.length > 0 && (
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
