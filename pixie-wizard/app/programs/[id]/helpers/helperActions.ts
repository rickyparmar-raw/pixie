"use server";

import { revalidatePath } from "next/cache";
import { linkedSlackSession, loadProgramContext } from "@/lib/programAccess";
import { addHostedHelper, revokeHostedHelper } from "@/lib/hostedPrograms";
import { coreHelperSetActive, coreRoutingExpertise } from "@/lib/pixieCore";
import type { ActionState } from "@/lib/types";

// Availability toggle: whether a helper is eligible for pings, routing and
// assignment. Dual-writes like hostedHelperSave: Core's program_helpers is
// what routing and the ping path actually consult; the wizard row keeps the
// dashboard roster consistent. Owner/admin only — Core re-checks helper
// membership regardless, but flipping someone else's availability is a
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
    if (active) {
      await addHostedHelper({ programId, slackUserId: userId, role: "helper", helperSource: "manual" }).catch(() => null);
    } else {
      await revokeHostedHelper(programId, userId).catch(() => null);
    }
    await coreHelperSetActive(programId, { userId, active, actorId: session.slackId });
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
