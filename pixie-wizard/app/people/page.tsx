import Link from "next/link";
import { requireWizardSuperadmin } from "@/lib/programAccess";
import { listWizardPeople, listActiveHostedPrograms } from "@/lib/hostedPrograms";
import { DashboardShell, PageHeader, Section, EmptyState, StatusBadge } from "@/app/_components/DashboardShell";
import { PersonGrantForm } from "./PersonGrantForm";

export default async function PeoplePage() {
  await requireWizardSuperadmin();
  const [people, programs] = await Promise.all([listWizardPeople(), listActiveHostedPrograms()]);
  return (
    <DashboardShell crumb="People & access">
      <PageHeader title="People & access" description="Manage Pixie identities and program-scoped access." />
      <div className="space-y-8">
        {/* A form is a column of fields, so the panel holds the width a form
            reads at — the same reason a record page stops at one measure. */}
        <div className="max-w-3xl">
          <Section
            bordered
            title="Add person"
            description="Grant existing verified identities access to one program at a time."
          >
            <PersonGrantForm programs={programs.map((program) => ({ id: program.id, name: program.program_name }))} />
          </Section>
        </div>

        <Section title={`Directory${people.length ? ` · ${people.length}` : ""}`}>
          {people.length === 0 ? (
            <EmptyState title="No managed identities yet." hint="Add a person above to create the first access record." />
          ) : (
            /* Identity folds under the name on a phone — four columns of ids
               and dates is a sideways scroll, not a ledger — and the added
               date lives on the person's own page. */
            <div className="overflow-x-auto">
              <table className="pixie-table sm:min-w-[560px]">
                <thead>
                  <tr>
                    <th className="sm:whitespace-nowrap">Person</th>
                    <th className="hidden w-full sm:table-cell">Identity</th>
                    <th>Status</th>
                    <th className="hidden sm:table-cell">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => (
                    <tr key={person.hca_id}>
                      <td className="sm:whitespace-nowrap">
                        <Link
                          className="text-text transition-colors hover:text-brand"
                          href={`/people/${encodeURIComponent(person.hca_id)}`}
                        >
                          {person.display_name}
                        </Link>
                        <span className="mt-0.5 block text-[12px] text-text-muted sm:hidden">
                          {person.email}
                          {person.slack_user_id ? (
                            <span className="font-mono"> · @{person.slack_user_id}</span>
                          ) : (
                            " · not linked"
                          )}
                        </span>
                      </td>
                      <td className="hidden font-mono text-xs text-text-muted sm:table-cell">
                        {person.email}
                        {person.slack_user_id ? ` · @${person.slack_user_id}` : " · not linked"}
                      </td>
                      <td className="whitespace-nowrap">
                        <StatusBadge status={person.status} />
                      </td>
                      <td className="hidden whitespace-nowrap font-mono text-xs text-text-muted sm:table-cell">
                        {new Date(person.added_at).toLocaleDateString([], {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </DashboardShell>
  );
}
