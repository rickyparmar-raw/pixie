import { requireWizardSuperadmin } from "@/lib/programAccess";
import { getWizardPerson, listProgramAccessForPerson } from "@/lib/hostedPrograms";
import { DashboardShell, PageHeader, Section, EmptyState } from "@/app/_components/DashboardShell";

export default async function PersonPage({ params }: { params: Promise<{ hcaId: string }> }) {
  await requireWizardSuperadmin();
  const { hcaId } = await params;
  const person = await getWizardPerson(decodeURIComponent(hcaId));
  if (!person) return <DashboardShell crumb="People"><EmptyState title="Person not found." /></DashboardShell>;
  const access = await listProgramAccessForPerson(person.hca_id);
  return <DashboardShell crumb="People"><PageHeader title={person.display_name} description="Identity and program-scoped access." />
    <div className="space-y-10"><Section title="Identity"><dl className="grid gap-2 text-sm"><div><dt className="text-xs uppercase text-text-muted">Account</dt><dd>{person.email}</dd></div><div><dt className="text-xs uppercase text-text-muted">HCA ID</dt><dd className="font-mono text-xs">{person.hca_id}</dd></div><div><dt className="text-xs uppercase text-text-muted">Slack</dt><dd className="font-mono text-xs">{person.slack_user_id ? `@${person.slack_user_id}` : "Not linked"}</dd></div></dl></Section>
      <Section title="Program access">{access.length ? <ul className="divide-y divide-line border-y border-line">{access.map((row) => <li key={row.id} className="flex justify-between py-3 text-sm"><span>{row.program_name}</span><span className="font-mono text-xs text-text-muted">{row.role}</span></li>)}</ul> : <EmptyState title="No active program access." />}</Section>
    </div>
  </DashboardShell>;
}
