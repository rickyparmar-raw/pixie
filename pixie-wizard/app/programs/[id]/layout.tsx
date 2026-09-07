import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { relationshipFor } from "@/lib/programAccess";
import { DashboardShell } from "@/app/_components/DashboardShell";

// Only checks that a session exists and the program is real — NOT
// membership. Every management route under here (tickets, audit, settings,
// ...) independently calls requireProgramMembership() itself; this layout's
// only job is choosing which shell to render, not authorizing anything.
// A non-member still reaches the index page — it renders the public profile
// instead of the dashboard — but never sees the management nav that would
// only 403 the moment they clicked it.
export default async function ProgramLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");
  const program = await getHostedProgram(id);
  if (!program) redirect("/programs");

  const relationship = await relationshipFor(program, session);
  if (relationship === "public") return <>{children}</>;

  return <DashboardShell programId={id} programName={program.program_name}>{children}</DashboardShell>;
}
