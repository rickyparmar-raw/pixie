"use server";

import { revalidatePath } from "next/cache";
import { linkedSlackSession, loadProgramContext } from "@/lib/programAccess";
import { setHostedHelperPingEligibility } from "@/lib/hostedPrograms";
import { coreHelperSetActive, coreRoutingExpertise } from "@/lib/pixieCore";
import type { ActionState } from "@/lib/types";

// Ping toggle: whether a helper is offered tickets and pinged automatically.
// A paused helper stays on the roster (commands, manual assignment). Core's
// program_helpers.ping_eligible is what routing consults; the wizard row's
// eligible_for_pings mirrors it for the dashboard. Owner/admin only — Core
// re-checks membership regardless, but changing someone else's pings is a
// management action, not a helper one.
export async function setHelperAvailabilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const userId = String(formData.get("helperUserId") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "true";
  if (!programId || !userId) return { error: "Missing helper fields." };
  const { relationship } = await loadProgramContext(programId);
  if (relationship !== "owner" && relationship !== "admin") {
    return { error: "Only the program owner or an admin can change availability." };
  }
  try {
    await setHostedHelperPingEligibility(programId, userId, active).catch(() => null);
    await coreHelperSetActive(programId, { userId, pingEligible: active, actorId: session.slackId });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Availability update failed." };
  }
  revalidatePath(`/programs/${programId}/helpers`);
  return { error: null, ok: true };
}

// Expertise tags: what this helper actually knows, suggested from the
// program's own categories. Any helper on the program may update tags
// (their own or a teammate's) — Core records observed resolutions
// separately, so declarations never overwrite verified history.
export async function setHelperExpertiseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await linkedSlackSession();
  if (!session) return { error: "Link your Slack account first." };
  const programId = String(formData.get("programId") ?? "");
  const userId = String(formData.get("helperUserId") ?? "").trim();
  const tags = String(formData.get("helperTags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!programId || !userId) return { error: "Missing helper fields." };
  const { relationship } = await loadProgramContext(programId);
  if (relationship === "public") return { error: "You don't have helper access to this program." };
  try {
    await coreRoutingExpertise(programId, { actorId: session.slackId, userId, tags });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Expertise update failed." };
  }
  revalidatePath(`/programs/${programId}/helpers`);
  return { error: null, ok: true };
}
