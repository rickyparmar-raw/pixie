import { requireProgramMembership } from "@/lib/programAccess";
import { listHostedHelpers } from "@/lib/hostedPrograms";
import { coreUserInfo, coreConfigured } from "@/lib/pixieCore";
import { DashboardShell, PageHeader, Section, EmptyState } from "@/app/_components/DashboardShell";
import { PersonGrantForm } from "@/app/people/PersonGrantForm";
import { PersonAccessActions } from "./PersonAccessActions";

export default async function ProgramPeoplePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program, relationship } = await requireProgramMembership(id);
  const helpers = await listHostedHelpers(id);

  // Resolve Slack IDs to display names via Core — the same lookup the public
  // roster uses. Each row degrades to the raw @ID on its own if Core is down
  // or doesn't know the user; one failure never blocks the rest.
  const roster = (
    await Promise.allSettled(
      helpers.map(async (helper) => {
        try {
          const info = coreConfigured() ? await coreUserInfo(helper.slack_user_id) : null;
          return { ...helper, displayName: info?.ok ? info.displayName ?? null : null };
        } catch {
          return { ...helper, displayName: null };
        }
      }),
    )
  ).map((result, i) => (result.status === "fulfilled" ? result.value : { ...helpers[i], displayName: null }));

  return <DashboardShell programId={id} programName={program.program_name}>
    <PageHeader title="People" description="Program-scoped access. Visibility never changes permissions." />
    <div className="space-y-12">
      <Section title="Roster">
        {roster.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {roster.map((helper) => (
              <li key={helper.slack_user_id} className="flex items-center justify-between gap-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-text">{helper.displayName ?? `@${helper.slack_user_id}`}</span>
                  {helper.displayName && (
                    <span className="block font-mono text-xs text-text-muted">@{helper.slack_user_id}</span>
                  )}
                </span>
                <span className="font-mono text-xs text-text-muted">{helper.role}</span>
                <PersonAccessActions programId={id} slackUserId={helper.slack_user_id} role={helper.role} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No people assigned." />
        )}
      </Section>
      {(relationship === "owner" || relationship === "admin") && <Section title="Add person"><PersonGrantForm programId={id} /></Section>}
    </div>
  </DashboardShell>;
}
