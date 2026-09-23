"use server";

import { revalidatePath } from "next/cache";
import { linkedSlackSession, loadProgramContext } from "@/lib/programAccess";
import { coreKnowledgeRefresh } from "@/lib/pixieCore";

// Fire-and-forget source refresh. Core kicks the fetch fan-out off and
// returns { started: true } without waiting for it, so this action is fast
// by construction — the status table picks up Fetching/Processing on the
// next render, not this one.
export async function refreshKnowledgeSources(programId: string): Promise<{ ok: boolean; error?: string }> {
  const session = await linkedSlackSession();
  if (!session) return { ok: false, error: "Link your Slack account first." };
  const { relationship } = await loadProgramContext(programId);
  if (relationship === "public") return { ok: false, error: "You don't have helper access to this program." };
  try {
    await coreKnowledgeRefresh(programId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Refresh failed." };
  }
  revalidatePath(`/programs/${programId}/knowledge`);
  return { ok: true };
}
