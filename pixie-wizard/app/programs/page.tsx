import Link from "next/link";
import { hostedProgramRepository } from "@/lib/repositories/hostedProgramRepository";
import { relationshipFor, requireWizardSuperadmin } from "@/lib/programAccess";
import { DashboardShell, PageHeader, StatusBadge } from "@/app/_components/DashboardShell";
import type { ProgramRelationship } from "@/lib/types";

const RELATIONSHIP_LABEL: Record<ProgramRelationship, string> = {
  owner: "Owner",
  admin: "Admin",
  helper: "Helper",
  public: "",
};

const ACTION_LABEL: Record<ProgramRelationship, string> = {
  owner: "Manage →",
  admin: "Open →",
  helper: "Open →",
  public: "View →",
};

// The directory — superadmin-only. Everyone else only ever needs the one
// program they actually work on; see requireWizardSuperadmin.
export default async function ProgramsIndex() {
  const session = await requireWizardSuperadmin();

  const programs = await hostedProgramRepository.listActiveHostedPrograms().catch(() => []);
  const withRelationship = await Promise.all(
    programs.map(async (p) => ({ program: p, relationship: await relationshipFor(p, session) })),
  );
  // Your programs first (owner, then admin, then helper), each group by name;
  // programs you only have public access to fall to the bottom.
  const rank: Record<ProgramRelationship, number> = { owner: 0, admin: 1, helper: 2, public: 3 };
  withRelationship.sort(
    (a, b) => rank[a.relationship] - rank[b.relationship] || a.program.program_name.localeCompare(b.program.program_name),
  );

  return (
    <DashboardShell crumb="Programs">
      <PageHeader
        title="Programs"
        description="Every active hosted Pixie program. Membership only changes what you can manage."
      />

      {withRelationship.length === 0 ? (
        <p className="text-sm text-text-muted">No active hosted programs yet.</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {withRelationship.map(({ program: p, relationship }) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link href={`/programs/${p.id}`} className="text-sm text-text hover:text-brand">
                    {p.program_name}
                  </Link>
                  {RELATIONSHIP_LABEL[relationship] && (
                    <span className="text-[11px] text-text-muted">{RELATIONSHIP_LABEL[relationship]}</span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-text-muted">{p.program_description ?? "No description"}</p>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <StatusBadge status={p.status} />
                <Link href={`/programs/${p.id}`} className="text-text-muted hover:text-text">
                  {ACTION_LABEL[relationship]}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashboardShell>
  );
}
