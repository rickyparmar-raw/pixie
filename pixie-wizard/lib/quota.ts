import { query } from "@/lib/db";
import { coreUsage, type CoreUsageAggregate } from "@/lib/pixieCore";

export type Plan = "starter" | "growth" | "scale";
export type EntitlementStatus = "active" | "past_due" | "suspended";
export type CostPrecision = "exact" | "estimated" | "unavailable";

export const PRICING_CATALOG = Object.freeze<Record<string, { input: number; cachedInput: number; output: number }>>({
  "openai:gpt-4o-mini": { input: 15, cachedInput: 2, output: 60 },
});

export interface Entitlement {
  workspaceId: string;
  plan: Plan;
  status: EntitlementStatus;
  includedCents: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

export interface QuotaResult {
  programId: string;
  workspaceId: string;
  plan: Plan | null;
  status: EntitlementStatus | "unavailable";
  usedCents: number | null;
  includedCents: number | null;
  remainingCents: number | null;
  precision: CostPrecision;
  usage: Pick<CoreUsageAggregate, "requests" | "inputTokens" | "outputTokens" | "cachedInputTokens"> | null;
}

export async function getEntitlement(programId: string, at = new Date()): Promise<Entitlement | null> {
  const { rows } = await query<Entitlement & { workspace_id: string; program_id: string; included_cents: number; effective_from: string; effective_until: string | null }>(
    `select workspace_id, plan, status, included_cents, effective_from, effective_until
       from wizard_entitlements
       where program_id = $1
        and effective_from <= $2
        and (effective_until is null or effective_until > $2)
      order by effective_from desc limit 1`,
    [programId, at],
  );
  const row = rows[0];
  return row ? {
    workspaceId: row.workspace_id,
    plan: row.plan,
    status: row.status,
    includedCents: row.included_cents,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
  } : null;
}

export function calculateUsedCents(usage: CoreUsageAggregate): { cents: number | null; precision: CostPrecision } {
  if (usage.precision === "exact") return usage.summary.costCents === null ? { cents: null, precision: "unavailable" } : { cents: usage.summary.costCents, precision: "exact" };
  if (usage.precision === "unavailable") return { cents: null, precision: "unavailable" };
  const total = usage.model.reduce((sum, row) => {
    const prices = PRICING_CATALOG[`${row.provider}:${row.name}`];
    const uncachedInputTokens = Math.max(0, row.inputTokens - row.cachedInputTokens);
    return prices ? sum + (uncachedInputTokens * prices.input + row.cachedInputTokens * prices.cachedInput + row.outputTokens * prices.output) / 1_000_000 : NaN;
  }, 0);
  return Number.isFinite(total) ? { cents: total, precision: "estimated" } : { cents: null, precision: "unavailable" };
}

export async function getQuota(programId: string, from: string, to: string): Promise<QuotaResult> {
  const [entitlement, usage] = await Promise.all([getEntitlement(programId), coreUsage(programId, { from, to })]);
  const cost = calculateUsedCents(usage);
  return {
    programId,
    workspaceId: entitlement?.workspaceId ?? "",
    plan: entitlement?.plan ?? null,
    status: entitlement?.status ?? "unavailable",
    usedCents: cost.cents,
    includedCents: entitlement?.includedCents ?? null,
    remainingCents: cost.cents === null || !entitlement ? null : Math.max(0, entitlement.includedCents - cost.cents),
    precision: cost.precision,
    usage: { requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens },
  };
}
