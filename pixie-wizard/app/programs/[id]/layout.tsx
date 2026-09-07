import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { DashboardShell } from "@/app/_components/DashboardShell";

export default async function ProgramLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");
  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/programs");
  return <DashboardShell programId={id} programName={program.program_name}>{children}</DashboardShell>;
}
