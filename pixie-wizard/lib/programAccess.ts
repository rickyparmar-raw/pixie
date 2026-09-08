// Server-side authorization for hosted program pages. Every management
// route under /programs/[id]/* calls requireProgramMembership() itself —
// deliberately redundant with any check a shared layout might also do,
// because a route that only trusts its layout for authorization is one
// refactor away from silently losing that check. Redirecting a non-member
// to the public profile (rather than throwing) matches the product
// requirement directly: a non-member isn't an error case, they're a reader.
import { redirect } from "next/navigation";
import { getSession, type WizardSession } from "@/lib/session";
import { getHostedProgram, listHostedHelpers } from "@/lib/hostedPrograms";
import type { HostedProgramRow, ProgramRelationship } from "@/lib/types";

export async function relationshipFor(
  program: HostedProgramRow,
  session: WizardSession | null,
): Promise<ProgramRelationship> {
  if (!session) return "public";
  if (program.owner_hca_id === session.hcaId) return "owner";
  if (session.slackId) {
    const helpers = await listHostedHelpers(program.id);
    const mine = helpers.find((h) => h.slack_user_id === session.slackId);
    if (mine?.role === "organizer") return "admin";
    if (mine) return "helper";
  }
  return "public";
}

export interface ProgramMembership {
  program: HostedProgramRow;
  session: WizardSession;
  relationship: Exclude<ProgramRelationship, "public">;
}

// Slack-linked session for Core-mutating actions. Core re-verifies helper
// membership from actorId before mutating, but anonymous calls must not
// reach it at all — every ticket/copilot/macro/helper/incident/radar
// action starts here instead of repeating the getSession + slackId pair.
export async function linkedSlackSession(): Promise<(WizardSession & { slackId: string }) | null> {
  const session = await getSession();
  if (!session || !session.slackId) return null;
  return { ...session, slackId: session.slackId };
}

// The gate every management page (tickets, audit, analytics, settings, ...)
// must call before reading or rendering anything program-specific. Redirects
// to the public profile for a non-member — never throws, never renders a
// generic error page that would itself confirm "this program exists and you
// can't see it" any louder than the profile already does on purpose.
export async function requireProgramMembership(programId: string): Promise<ProgramMembership> {
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(programId);
  if (!program) redirect("/programs");

  const relationship = await relationshipFor(program, session);
  if (relationship === "public") redirect(`/programs/${programId}`);

  return { program, session, relationship };
}
