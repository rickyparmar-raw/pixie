import { requireProgramMembership } from "@/lib/programAccess";
import { IncidentDetailSection } from "../page";

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string; incidentId: string }> }) {
  const { id, incidentId } = await params;
  await requireProgramMembership(id);

  return <IncidentDetailSection programId={id} incidentId={Number(incidentId)} />;
}
