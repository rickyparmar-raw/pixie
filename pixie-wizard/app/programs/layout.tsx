import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { DashboardShell } from "@/app/_components/DashboardShell";

export default async function ProgramsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/");
  return <DashboardShell>{children}</DashboardShell>;
}
