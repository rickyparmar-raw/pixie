import { requireProgramMembership } from "@/lib/programAccess";
import { listHostedHelpers } from "@/lib/hostedPrograms";
import { coreHelpers, coreRoutingRecommend } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";
import { HelperAddForm, HelperVisibilityToggle } from "./HelperForms";

interface Helper {
  user_id: string;
  helper_source: string;
  role: string;
  active: number;
}

export default async function HelpersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { relationship } = await requireProgramMembership(id);
  const canManageVisibility = relationship === "owner" || relationship === "admin";
  const wizardHelpers = canManageVisibility ? await listHostedHelpers(id).catch(() => []) : [];

  let helpers: Helper[] = [];
  let recommendations: Array<{ userId: string; score: number; reasons: string[] }> = [];
  let loadError: string | null = null;
  try {
    [helpers, recommendations] = await Promise.all([
      coreHelpers(id) as Promise<Helper[]>,
      coreRoutingRecommend(id) as Promise<typeof recommendations>,
    ]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load helpers.";
  }

  const active = helpers.filter((h) => h.active);

  return (
    <>
      <PageHeader
        title="Helpers"
        description="Organizers add helpers here. Removing a helper revokes access immediately."
      />

      {loadError && <CoreError message={loadError} />}

      <div className="space-y-12">
        <Section title={`Active (${active.length})`}>
          <ul className="space-y-1 text-sm">
            {active.map((h) => (
              <li key={h.user_id} className="text-text">
                &lt;@{h.user_id}&gt; <span className="text-text-muted">· {h.role} · via {h.helper_source}</span>
              </li>
            ))}
            {active.length === 0 && !loadError && (
              <li className="text-text-muted">No helpers yet. You&apos;re the organizer as creator.</li>
            )}
          </ul>
        </Section>

        {recommendations.length > 0 && (
          <Section title="Recommended now" description="Ranked from expertise tags and recent resolution history.">
            <ul className="space-y-1 text-sm">
              {recommendations.map((r) => (
                <li key={r.userId} className="text-text">
                  &lt;@{r.userId}&gt; <span className="text-text-muted">· score {r.score} · {r.reasons.join("; ")}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {canManageVisibility && wizardHelpers.length > 0 && (
          <Section
            title="Public profile visibility"
            description="Hiding a helper here only affects the public program profile. It never changes their permissions."
          >
            <div className="space-y-2">
              {wizardHelpers.map((h) => (
                <HelperVisibilityToggle key={h.slack_user_id} programId={id} slackUserId={h.slack_user_id} role={h.role} visible={h.visible_on_profile} />
              ))}
            </div>
          </Section>
        )}

        <HelperAddForm programId={id} />
      </div>
    </>
  );
}
