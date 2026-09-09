import Link from "next/link";
import { requireWizardSuperadmin } from "@/lib/programAccess";
import { listWizardPeople, listActiveHostedPrograms } from "@/lib/hostedPrograms";
import { DashboardShell, PageHeader, Section, EmptyState } from "@/app/_components/DashboardShell";
import { PersonGrantForm } from "./PersonGrantForm";

export default async function PeoplePage() {
  await requireWizardSuperadmin();
  const [people, programs] = await Promise.all([listWizardPeople(), listActiveHostedPrograms()]);
  return (
    <DashboardShell crumb="People & access">
      <PageHeader title="People & access" description="Manage Pixie identities and program-scoped access." />
      <div className="space-y-12">
        <Section title="Add person" description="Grant existing verified identities access to one program at a time.">
          <PersonGrantForm programs={programs.map((program) => ({ id: program.id, name: program.program_name }))} />
        </Section>
        <Section title={`Directory${people.length ? ` · ${people.length}` : ""}`}>
          {people.length === 0 ? <EmptyState title="No managed identities yet." hint="Add a person above to create the first access record." /> : (
            <div className="overflow-x-auto border-y border-line">
              <table className="w-full text-left text-sm">
                <thead className="font-mono text-xs uppercase text-text-muted"><tr><th className="py-2">Person</th><th>Identity</th><th>Status</th><th>Added</th></tr></thead>
                <tbody>{people.map((person) => <tr key={person.hca_id} className="border-t border-line">
                  <td className="py-3"><Link className="text-brand underline" href={`/people/${encodeURIComponent(person.hca_id)}`}>{person.display_name}</Link></td>
                  <td className="font-mono text-xs text-text-muted">{person.email}{person.slack_user_id ? ` · @${person.slack_user_id}` : ""}</td>
                  <td>{person.status}</td><td className="text-xs text-text-muted">{new Date(person.added_at).toLocaleDateString()}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </DashboardShell>
  );
}
