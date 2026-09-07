import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { listActiveHostedPrograms } from "@/lib/hostedPrograms";
import { relationshipFor } from "@/lib/programAccess";
import { PageHeader, SectionCard, StatusBadge } from "@/app/_components/DashboardShell";
import type { ProgramRelationship } from "@/lib/types";

const RELATIONSHIP_LABEL: Record<ProgramRelationship, string> = {
  owner: "OWNER",
  admin: "ADMIN",
  helper: "HELPER",
  public: "PUBLIC",
};

const ACTION_LABEL: Record<ProgramRelationship, string> = {
  owner: "Manage →",
  admin: "Support workspace →",
  helper: "Support workspace →",
  public: "View program →",
};

// The directory: every active hosted program is discoverable by anyone
// signed in, regardless of membership. Membership only changes what the
// destination page renders (full dashboard vs public profile) and which
// action label this card shows — it never hides a program's existence.
export default async function ProgramsIndex() {
  const session = await getSession();
  if (!session) redirect("/");

  const programs = await listActiveHostedPrograms().catch(() => []);
  const withRelationship = await Promise.all(
    programs.map(async (p) => ({ program: p, relationship: await relationshipFor(p, session) })),
  );

  return (
    <main className="max-w-none px-0 py-0">
      <PageHeader eyebrow="Directory" title="Programs" description="Every active hosted Pixie program. Anyone signed in can see this list — membership only changes what you can manage." actions={<Link href="/wizard?mode=hosted" className="pixie-button pixie-button-primary">New program</Link>} />

      <SectionCard title="All active programs">
        <ul className="divide-y divide-line">
          {withRelationship.map(({ program: p, relationship }) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-heading text-sm text-text">{p.program_name}</span>
                  <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] tracking-[0.1em] text-text-muted">
                    {RELATIONSHIP_LABEL[relationship]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-muted">{p.program_description ?? "No description"}</p>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <StatusBadge status={p.status} />
                <Link href={`/programs/${p.id}`} className="text-text hover:text-brand">
                  {ACTION_LABEL[relationship]}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>
      {withRelationship.length === 0 && <p className="mt-6 text-sm text-text-muted">No active hosted programs yet.</p>}
    </main>
  );
}
