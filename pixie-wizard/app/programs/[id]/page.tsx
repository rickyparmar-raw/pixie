import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram, listHostedChannels, listHostedAudit } from "@/lib/hostedPrograms";
import { ProgramSettingsForms } from "./ProgramSettingsForms";

export default async function ProgramPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program) redirect("/wizard");
  if (program.owner_hca_id !== session.hcaId) redirect("/wizard");

  const [channels, audit] = await Promise.all([listHostedChannels(id), listHostedAudit(id, 20)]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">hosted pixie · {program.status}</p>
      <h1 className="font-heading mt-3 text-2xl text-text">{program.program_name}</h1>
      <p className="mt-2 text-sm text-text-muted">
        Support identity <span className="text-text">{program.support_name ?? `${program.program_name} Help`}</span>
        {" · "}Core sync <span className="text-text">{program.core_sync_state}</span>
        {program.core_sync_state === "failed" && program.core_sync_error && (
          <span> — {program.core_sync_error}. Settings are saved and retry on the next save.</span>
        )}
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href={`/programs/${id}/tickets`} className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">
          Open tickets →
        </Link>
        {[
          ["knowledge", "Knowledge"],
          ["gaps", "FAQ gaps"],
          ["macros", "Macros"],
          ["helpers", "Helpers"],
          ["analytics", "Analytics"],
          ["incidents", "Incidents"],
          ["audit", "Audit"],
          ["retention", "Retention"],
        ].map(([slug, label]) => (
          <Link key={slug} href={`/programs/${id}/${slug}`} className="rounded-md border border-line px-4 py-2 font-heading text-sm text-text-muted hover:text-text">
            {label}
          </Link>
        ))}
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Channels</h2>
        <ul className="mt-3 space-y-1 text-sm text-text">
          {channels.map((c) => (
            <li key={`${c.workspace_id}:${c.channel_id}`} className="font-mono">
              &lt;#{c.channel_id}&gt; <span className="font-sans text-text-muted">· {c.kind}</span>
            </li>
          ))}
          {channels.length === 0 && <li className="text-text-muted">No channels claimed yet.</li>}
        </ul>
      </div>

      <div className="mt-6">
        <ProgramSettingsForms program={program} />
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Recent activity</h2>
        <ul className="mt-3 space-y-2 text-sm text-text-muted">
          {(audit as Array<{ id: string; action: string; created_at: string }>).map((e) => (
            <li key={e.id}>
              <span className="text-text">{e.action}</span> · {new Date(e.created_at).toLocaleString()}
            </li>
          ))}
          {audit.length === 0 && <li>No activity yet.</li>}
        </ul>
      </div>
    </main>
  );
}
