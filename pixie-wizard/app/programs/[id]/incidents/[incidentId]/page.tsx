import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { IncidentDetailSection } from "../page";

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string; incidentId: string }> }) {
  const { id, incidentId } = await params;
  await requireProgramMembership(id);

  return (
    <main className="max-w-none px-0 py-0">
      <IncidentDetailSection programId={id} incidentId={Number(incidentId)} />
      <Link href={`/programs/${id}/incidents`} className="mt-8 inline-block text-sm text-text-muted underline">← All incidents</Link>
    </main>
  );
}
