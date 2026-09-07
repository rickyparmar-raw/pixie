import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { coreHelpers, coreRoutingRecommend } from "@/lib/pixieCore";
import { HelperAddForm } from "./HelperForms";

interface Helper {
  user_id: string;
  helper_source: string;
  role: string;
  active: number;
}

export default async function HelpersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  let helpers: Helper[] = [];
  let recommendations: Array<{ userId: string; score: number; reasons: string[] }> = [];
  let loadError: string | null = null;
  try {
    [helpers, recommendations] = await Promise.all([
      coreHelpers(id) as Promise<Helper[]>,
      coreRoutingRecommend(id) as Promise<typeof recommendations>,
    ]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load helpers.";
  }

  return (
    <main className="max-w-none px-0 py-0">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · helpers</p>
      <h1 className="font-heading mt-3 text-2xl text-text">Who can help</h1>
      <p className="mt-2 text-sm text-text-muted">Membership derives from organizer adds below. Removals revoke access immediately.</p>

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      <div className="mt-6 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Active ({helpers.filter((h) => h.active).length})</h2>
        <ul className="mt-3 space-y-1 text-sm text-text">
          {helpers.filter((h) => h.active).map((h) => (
            <li key={h.user_id}>&lt;@{h.user_id}&gt; <span className="text-text-muted">· {h.role} · via {h.helper_source}</span></li>
          ))}
          {helpers.filter((h) => h.active).length === 0 && !loadError && <li className="text-text-muted">No helpers yet — you (creator) are organizer.</li>}
        </ul>
      </div>

      {recommendations.length > 0 && (
        <div className="mt-6 rounded-lg border border-line bg-panel p-6">
          <h2 className="font-heading text-lg text-text">Recommended right now</h2>
          <ul className="mt-3 space-y-2 text-sm text-text">
            {recommendations.map((r) => (
              <li key={r.userId}>&lt;@{r.userId}&gt; <span className="text-text-muted">· score {r.score} — {r.reasons.join("; ")}</span></li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <HelperAddForm programId={id} />
      </div>

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back</Link>
    </main>
  );
}
