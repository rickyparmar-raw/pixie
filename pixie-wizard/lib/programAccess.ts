// Server-side authorization for hosted program pages. Every management
// route under /programs/[id]/* calls requireProgramMembership() itself —
// deliberately redundant with any check a shared layout might also do,
// because a route that only trusts its layout for authorization is one
// refactor away from silently losing that check. Redirecting a non-member
// to the public profile (rather than throwing) matches the product
// requirement directly: a non-member isn't an error case, they're a reader.
import { cache } from "react";
import { redirect } from "next/navigation";
import { getSession, ownsIdentifier, type WizardSession } from "@/lib/session";
import {
  getHostedProgram,
  getHelperRow,
  isWizardSuperadmin,
  listHostedProgramsForOwner,
  listProgramAccessForPerson,
} from "@/lib/hostedPrograms";
import type { HostedProgramRow, ProgramRelationship } from "@/lib/types";

export async function relationshipFor(
  program: HostedProgramRow,
  session: WizardSession | null,
): Promise<ProgramRelationship> {
  if (!session) return "public";
  if (ownsIdentifier(program.owner_hca_id, session)) return "owner";
  if (session.slackId) {
    // Targeted single-row lookup (program + this Slack user), not the whole
    // roster — same active-only, role semantics as before.
    const mine = await getHelperRow(program.id, session.slackId);
    if (mine?.role === "organizer") return "admin";
    if (mine) return "helper";
  }
  return "public";
}

export interface ProgramContext {
  session: WizardSession | null;
  program: HostedProgramRow | null;
  relationship: ProgramRelationship;
}

// The one place session + program row + relationship are resolved for a
// hosted-program request. React.cache keys it by programId and holds the
// result for exactly one request, so the layout, the page, and every nested
// server component that calls loadProgramContext(id) share a single
// resolution — the pre-change duplicate (layout AND page each re-running
// getSession + getHostedProgram + a roster fetch) collapses to one pass.
// Not a cross-request or cross-user cache: cache() retains nothing between
// requests, the key is the program id, and every request still runs the
// full authorization — it just isn't recomputed within the same request.
export const loadProgramContext = cache(async (programId: string): Promise<ProgramContext> => {
  const session = await getSession();
  const program = await getHostedProgram(programId);
  const relationship = program ? await relationshipFor(program, session) : "public";
  return { session, program, relationship };
});

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
  const { session, program, relationship } = await loadProgramContext(programId);
  if (!session) redirect("/");
  if (!program) redirect("/programs");
  if (relationship === "public") redirect(`/programs/${programId}`);

  return { program, session, relationship };
}

export async function isSuperadminSession(identity: { hcaId: string; email: string }): Promise<boolean> {
  return (await isWizardSuperadmin(identity.hcaId)) || (await isWizardSuperadmin(identity.email));
}

// Where a non-superadmin lands instead of a workspace-level page they can't
// use: their own program, if they have one (owned first, then a helper
// role). An account with neither goes to /wizard, not the marketing home —
// /wizard is what actually explains why (the invite-only message), whereas
// bouncing to "/" gives a signed-in person zero signal about what just
// happened, which is exactly what a real user hit and reported as "sign-in
// is broken" when it was actually just a silent, unexplained redirect.
export async function ownProgramPath(identity: { hcaId: string; email: string }): Promise<string> {
  const owned = await listHostedProgramsForOwner(identity).catch(() => []);
  if (owned[0]) return `/programs/${owned[0].id}`;
  const helping = await listProgramAccessForPerson(identity.hcaId).catch(() => []);
  if (helping[0]) return `/programs/${helping[0].id}`;
  return "/wizard";
}

// Workspace-level pages (overview, the program directory, people & access)
// are superadmin-only — everyone else only ever needs the one program they
// actually work on, not a cross-program view.
export async function requireWizardSuperadmin(): Promise<WizardSession> {
  const session = await getSession();
  if (!session) redirect("/");
  if (!(await isSuperadminSession(session))) redirect(await ownProgramPath(session));
  return session;
}
