import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { listHostedProgramsForOwner } from "@/lib/hostedPrograms";
import { PageHeader, SectionCard, StatusBadge } from "@/app/_components/DashboardShell";

export default async function ProgramsIndex() {
  const session = await getSession();
  if (!session) redirect("/");

  const programs = await listHostedProgramsForOwner(session.hcaId).catch(() => []);

  return (
    <main className="max-w-none px-0 py-0">
      <PageHeader eyebrow="Workspace" title="Programs" description="Hosted Pixie programs and their current support health." actions={<Link href="/wizard?mode=hosted" className="pixie-button pixie-button-primary">New program</Link>} />

      <SectionCard title="All programs" description="Only programs owned by your current account are shown."><ul className="divide-y divide-line">
        {programs.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
            <div><Link href={`/programs/${p.id}`} className="text-sm text-text hover:text-brand">
              <span className="font-heading text-sm">{p.program_name}</span>
            </Link><p className="mt-1 text-xs text-text-muted">{p.program_description ?? "No description"}</p></div><div className="flex items-center gap-3 text-xs"><StatusBadge status={p.status} /><span className="text-text-muted">sync {p.core_sync_state}</span></div>
          </li>
        ))}
      </ul></SectionCard>
      {programs.length === 0 && <p className="mt-6 text-sm text-text-muted">No hosted programs yet.</p>}
    </main>
  );
}
