import { redirect } from "next/navigation";
import { loadProgramContext, isSuperadminSession } from "@/lib/programAccess";
import { DashboardShell } from "@/app/_components/DashboardShell";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Only checks that a session exists and the program is real — NOT
// membership. Every management route under here (tickets, audit, settings,
// ...) independently calls requireProgramMembership() itself; this layout's
// only job is choosing which shell to render, not authorizing anything.
// A non-member still reaches the index page — it renders the public profile
// instead of the dashboard — but never sees the management nav that would
// only 403 the moment they clicked it.
export default async function ProgramLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same three reads the page will need — resolved once, request-scoped, and
  // reused there via loadProgramContext / requireProgramMembership.
  const { session, program, relationship } = await loadProgramContext(id);
  if (!session) redirect("/");
  if (!program) redirect("/programs");

  if (relationship === "public") return <>{children}</>;

  const isSuperadmin = await isSuperadminSession(session);

  return (
    <DashboardShell
      programId={id}
      programName={program.program_name}
      userName={session.name}
      userEmail={session.email}
      showWorkspaceNav={isSuperadmin}
    >
      {children}
    </DashboardShell>
  );
}
