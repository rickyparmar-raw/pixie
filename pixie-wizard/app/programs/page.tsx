import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { listHostedProgramsForOwner } from "@/lib/hostedPrograms";

export default async function ProgramsIndex() {
  const session = await getSession();
  if (!session) redirect("/");

  const programs = await listHostedProgramsForOwner(session.hcaId).catch(() => []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">pixie network</p>
      <h1 className="font-heading mt-3 text-2xl text-text">Your programs</h1>

      <ul className="mt-6 space-y-3">
        {programs.map((p) => (
          <li key={p.id} className="rounded-lg border border-line bg-panel p-4">
            <Link href={`/programs/${p.id}`} className="text-text hover:underline">
              <span className="font-heading text-sm">{p.program_name}</span>
            </Link>
            <p className="mt-1 text-xs text-text-muted">{p.status} · sync {p.core_sync_state}</p>
          </li>
        ))}
      </ul>
      {programs.length === 0 && <p className="mt-6 text-sm text-text-muted">No hosted programs yet.</p>}

      <Link href="/wizard?mode=hosted" className="mt-6 inline-block rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">
        Connect a program →
      </Link>
    </main>
  );
}
