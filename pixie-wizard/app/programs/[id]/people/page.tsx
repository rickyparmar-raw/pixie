import { requireProgramMembership } from "@/lib/programAccess";
import { listHostedHelpers } from "@/lib/hostedPrograms";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { DashboardShell, PageHeader, Section, EmptyState } from "@/app/_components/DashboardShell";
import { PersonGrantForm } from "@/app/people/PersonGrantForm";
import { PersonAccessActions } from "./PersonAccessActions";

export default async function ProgramPeoplePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program, relationship } = await requireProgramMembership(id);
  const helpers = await listHostedHelpers(id);
  // One Core round trip for the whole roster; each row degrades to "@<id>" on
  // its own if Core is down or doesn't know the user.
  const identities = await resolveIdentities(helpers.map((h) => h.slack_user_id));

  return <DashboardShell programId={id} programName={program.program_name}>
    <PageHeader title="People" description="Program-scoped access. Visibility never changes permissions." />
    <div className="space-y-12">
      <Section title="Roster">
        {helpers.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {helpers.map((helper) => {
              const label = labelFor(identities, helper.slack_user_id);
              return (
                <li key={helper.slack_user_id} className="flex items-center justify-between gap-4 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate text-text">{label}</span>
                    {label !== `@${helper.slack_user_id}` && (
                      <span className="block font-mono text-xs text-text-muted">@{helper.slack_user_id}</span>
                    )}
                  </span>
                  <span className="font-mono text-xs text-text-muted">{helper.role}</span>
                  <PersonAccessActions programId={id} slackUserId={helper.slack_user_id} role={helper.role} />
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No people assigned." />
        )}
      </Section>
      {(relationship === "owner" || relationship === "admin") && <Section title="Add person"><PersonGrantForm programId={id} /></Section>}
    </div>
  </DashboardShell>;
}
