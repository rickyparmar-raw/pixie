import { db } from "@/lib/supabase";
import type { PixieTrialRow, DocSource } from "@/lib/types";
import type { WizardSession } from "@/lib/session";

const LIVE_STATUSES = ["draft", "awaiting_slack_credentials", "provisioning", "active"];

export async function getLiveTrial(hcaId: string): Promise<PixieTrialRow | null> {
  const { data, error } = await db
    .from("pixie_trials")
    .select("*")
    .eq("requester_hca_id", hcaId)
    .in("status", LIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLiveTrial: ${error.message}`);
  return data as PixieTrialRow | null;
}

// Get-or-create is racy across two concurrent first page loads — the partial
// unique index in supabase/schema.sql is the real guard. A losing insert here
// just means someone else's row won; re-select and use that one.
export async function getOrCreateDraftTrial(session: WizardSession): Promise<PixieTrialRow> {
  const existing = await getLiveTrial(session.hcaId);
  if (existing) return existing;

  const { data, error } = await db
    .from("pixie_trials")
    .insert({
      requester_hca_id: session.hcaId,
      requester_email: session.email,
      requester_name: session.name,
      requester_slack_id: session.slackId,
      status: "draft",
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const row = await getLiveTrial(session.hcaId);
      if (row) return row;
    }
    throw new Error(`getOrCreateDraftTrial: ${error.message}`);
  }
  return data as PixieTrialRow;
}

export async function getTrialById(id: string): Promise<PixieTrialRow | null> {
  const { data, error } = await db.from("pixie_trials").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getTrialById: ${error.message}`);
  return data as PixieTrialRow | null;
}

export async function updateTrial(
  id: string,
  patch: Partial<PixieTrialRow>,
): Promise<PixieTrialRow> {
  const { data, error } = await db
    .from("pixie_trials")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`updateTrial: ${error.message}`);
  return data as PixieTrialRow;
}

export async function logTrialEvent(
  trialId: string,
  eventType: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("trial_events")
    .insert({ trial_id: trialId, event_type: eventType, detail: detail ?? null });
  if (error) throw new Error(`logTrialEvent: ${error.message}`);
}

// The three buckets app/api/cron/sweep-trials/route.ts sweeps, per plan §4.

export async function findExpiredActiveTrials(now: Date): Promise<PixieTrialRow[]> {
  const { data, error } = await db
    .from("pixie_trials")
    .select("*")
    .eq("status", "active")
    .lt("expires_at", now.toISOString());
  if (error) throw new Error(`findExpiredActiveTrials: ${error.message}`);
  return (data as PixieTrialRow[]) ?? [];
}

export async function findReclaimableTrials(now: Date): Promise<PixieTrialRow[]> {
  const { data, error } = await db
    .from("pixie_trials")
    .select("*")
    .eq("status", "paused")
    .lt("reclaim_deadline", now.toISOString());
  if (error) throw new Error(`findReclaimableTrials: ${error.message}`);
  return (data as PixieTrialRow[]) ?? [];
}

export async function findTrialsNeedingExpiryWarning(now: Date, warningWindowMs: number): Promise<PixieTrialRow[]> {
  const soon = new Date(now.getTime() + warningWindowMs).toISOString();
  const { data, error } = await db
    .from("pixie_trials")
    .select("*")
    .eq("status", "active")
    .is("expiry_notified_at", null)
    .not("expires_at", "is", null)
    .lte("expires_at", soon)
    .gt("expires_at", now.toISOString());
  if (error) throw new Error(`findTrialsNeedingExpiryWarning: ${error.message}`);
  return (data as PixieTrialRow[]) ?? [];
}

// Steps 1-3 all happen while status is still "draft" — there's no separate
// step counter column, so progress is read off which fields are already
// filled. Step 4 (Slack manifest handshake, task #18) is the first thing that
// actually advances status away from "draft".
export type WizardStep = 1 | 2 | 3 | "awaiting-slack";

export function stepForTrial(trial: PixieTrialRow): WizardStep {
  if (!trial.program_name) return 1;
  if (!trial.llm_key_encrypted) return 2;
  if (!trial.sources || (trial.sources as DocSource[]).length === 0) return 3;
  return "awaiting-slack";
}
