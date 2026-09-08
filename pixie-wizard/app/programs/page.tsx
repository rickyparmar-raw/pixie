import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { listActiveHostedPrograms } from "@/lib/hostedPrograms";
import { relationshipFor } from "@/lib/programAccess";
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

// The directory: every active hosted program is discoverable by anyone
// signed in. Membership only changes what the destination renders and which
// action label this row shows — it never hides a program.
export default async function ProgramsIndex() {
  const session = await getSession();
  if (!session) redirect("/");

  const programs = await listActiveHostedPrograms().catch(() => []);
  const withRelationship = await Promise.all(
    programs.map(async (p) => ({ program: p, relationship: await relationshipFor(p, session) })),
  );

  return (
    <DashboardShell crumb="Programs">
      <PageHeader
        title="Programs"
        description="Every active hosted Pixie program. Membership only changes what you can manage."
        actions={<Link href="/wizard?mode=hosted" className="pixie-button pixie-button-primary">New program</Link>}
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
