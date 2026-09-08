import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

// Auth guard only. The shell is chosen further down: the directory renders
// its own workspace shell, and /programs/[id] picks the program shell (or a
// bare public profile) in its own layout. Rendering DashboardShell here too
// would stack a second sidebar on every program route.
export default async function ProgramsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/");
  return <>{children}</>;
}
