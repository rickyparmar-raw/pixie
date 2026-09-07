import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { IncidentDetailSection } from "../page";

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string; incidentId: string }> }) {
  const { id, incidentId } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <IncidentDetailSection programId={id} incidentId={Number(incidentId)} />
      <Link href={`/programs/${id}/incidents`} className="mt-8 inline-block text-sm text-text-muted underline">← All incidents</Link>
    </main>
  );
}
