// Pixie Core internal API client (Core lib/web/serve.js /internal/v1/*).
//
// The browser never sees PIXIE_INTERNAL_TOKEN or the Core base URL: every
// function here runs server-side (server actions / route handlers). Core is
// the single writer of runtime state; when it is unreachable the control
// plane still records configuration and marks core_sync_state=pending —
// configured programs keep serving from Core's last-synced state.

import { timeoutFetch, REQUEST_TIMEOUT_MS } from "@/lib/timeoutFetch";
import { coreFetchErrorMessage } from "@/lib/pixieCoreErrors";
import { validateCoreProgramSyncPatch, type CoreProgramSyncPatch } from "@/lib/coreContracts";

// Read at call time, not import time: Next evaluates this module during
// prerender when env vars may be absent, and db.ts already takes the same
// lazy approach for its pool.
function coreBaseUrl(): string {
  return (process.env.PIXIE_CORE_BASE_URL || "").replace(/\/+$/, "");
}
function coreToken(): string {
  return process.env.PIXIE_INTERNAL_TOKEN || "";
}

export function coreConfigured(): boolean {
  return Boolean(coreBaseUrl() && coreToken());
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  if (!coreConfigured()) throw new Error("Pixie Core is not configured (PIXIE_CORE_BASE_URL/PIXIE_INTERNAL_TOKEN)");
  let res: Response;
  try {
    res = await timeoutFetch(`${coreBaseUrl()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${coreToken()}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
  } catch (err) {
    // timeoutFetch's AbortSignal.timeout rejects with a TimeoutError
    // DOMException; a hard network failure (DNS, refused, reset) lands here
    // too. coreFetchErrorMessage keeps the token, headers, and query string
    // out of what gets thrown.
    throw new Error(coreFetchErrorMessage(err, path, REQUEST_TIMEOUT_MS));
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// Every Core read/mutation below shares one contract: 200 with a JSON body,
// otherwise the body's own error or a fixed fallback naming the operation.
// One helper keeps a new endpoint from inventing a third error shape.
async function request<T>(path: string, fallback: string, init?: RequestInit): Promise<T> {
  const { status, body } = await call(path, init);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `${fallback} (${status})`);
  return body as T;
}

export interface CoreUsageParams {
  from: string;
  to: string;
  interval?: "hour" | "day";
}

export interface CoreUsageMetric {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costCents: number | null;
}
export interface CoreUsageSummary extends CoreUsageMetric {
  latencyMs: number | null;
  errors: number;
  rateLimited: number;
  groundedAnswers: number;
  fallbacks: number;
  suppressed: number;
}

export interface CoreUsageAggregate extends CoreUsageMetric {
  programId: string;
  from: string;
  to: string;
  precision: "exact" | "estimated" | "unavailable";
  summary: CoreUsageSummary;
  timeseries: Array<CoreUsageMetric & { at: string }>;
  operation: Array<CoreUsageMetric & { name: string }>;
  provider: Array<CoreUsageMetric & { name: string }>;
  model: Array<CoreUsageMetric & { provider: string; name: string }>;
  topConsumers: Array<CoreUsageMetric & { consumerId: string }>;
  recent: Array<{
    at: string;
    operation: string;
    provider: string;
    model: string;
    consumerId: string | null;
    requestId: string | null;
    status: string;
    latencyMs: number | null;
    rateLimited: boolean;
    retryCount: number;
  }>;
}

const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const metric = (value: unknown): value is CoreUsageMetric => {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CoreUsageMetric>;
  return [row.requests, row.inputTokens, row.outputTokens, row.cachedInputTokens].every(nonNegative)
    && (row.costCents === null || nonNegative(row.costCents));
};
const rows = (value: unknown): value is unknown[] => Array.isArray(value) && value.every((row) => row && typeof row === "object");

function isUsageAggregate(value: unknown, programId: string, params: CoreUsageParams): value is CoreUsageAggregate {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CoreUsageAggregate>;
  return row.programId === programId && row.from === params.from && row.to === params.to
    && metric(row.summary) && [row.requests, row.inputTokens, row.outputTokens, row.cachedInputTokens].every(nonNegative)
    && (row.costCents === null || nonNegative(row.costCents)) && rows(row.timeseries)
    && rows(row.operation) && rows(row.provider) && rows(row.model)
    && rows(row.topConsumers) && rows(row.recent)
    && (row.precision === "exact" || row.precision === "estimated" || row.precision === "unavailable");
}

export async function coreUsage(programId: string, params: CoreUsageParams): Promise<CoreUsageAggregate> {
  const from = Date.parse(params.from);
  const to = Date.parse(params.to);
  if (!programId || !params.from || !params.to || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error("usage range is invalid");
  }
  const query = new URLSearchParams({ from: params.from, until: params.to });
  if (params.interval) query.set("interval", params.interval);
  const body = await request<unknown>(
    `/internal/v1/programs/${encodeURIComponent(programId)}/usage?${query}`,
    "usage aggregation failed",
  );
  if (!isUsageAggregate(body, programId, params)) throw new Error("usage aggregation returned an invalid response");
  return body;
}

export const coreUsageAggregate = coreUsage;

function send(method: string, payload: Record<string, unknown>): RequestInit {
  return { method, body: JSON.stringify(payload) };
}

export async function syncProgramToCore(programId: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const validation = validateCoreProgramSyncPatch(programId, payload);
  if (!validation.ok) return { ok: false, error: validation.error.message };
  try {
    const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (status >= 200 && status < 300) return { ok: true };
    const error = (body as { error?: string })?.error || `core sync failed (HTTP ${status})`;
    return { ok: false, error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "core unreachable" };
  }
}

export async function coreTicketSearch(params: Record<string, string>): Promise<{ total: number; rows: unknown[] }> {
  return request(`/internal/v1/tickets?${new URLSearchParams(params).toString()}`, "ticket search failed");
}

export async function coreTicketAction(ticketId: number, action: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/tickets/${ticketId}/${action}`, "ticket action failed", send("PATCH", payload));
}

export async function coreTicketReply(ticketId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/tickets/${ticketId}/reply`, "reply failed", send("POST", payload));
}

export async function coreTicketDetail(ticketId: number, programId: string): Promise<unknown> {
  return request(`/internal/v1/tickets/${ticketId}?programId=${encodeURIComponent(programId)}`, "ticket lookup failed");
}

export async function coreTicketNote(ticketId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/tickets/${ticketId}/notes`, "note failed", send("POST", payload));
}

export async function coreKnowledgeCandidates(programId: string, status = "candidate"): Promise<unknown[]> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/knowledge/candidates?status=${encodeURIComponent(status)}`,
    "candidates lookup failed",
  );
}

export async function coreKnowledgePropose(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/knowledge/candidates`,
    "candidate proposal failed",
    send("POST", payload),
  );
}

export async function coreKnowledgeReview(candidateId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/knowledge/candidates/${candidateId}`, "candidate review failed", send("PATCH", payload));
}

export async function coreGapClusters(programId: string): Promise<{ clusters: unknown[] }> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/gaps/clusters`, "gap clusters failed");
}

export async function coreFaqPropose(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/gaps/clusters`,
    "FAQ proposal failed",
    send("POST", payload),
  );
}

export async function coreCopilot(action: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/copilot/${action}`, `copilot ${action} failed`, send("POST", payload));
}

export interface CoreChannel {
  id: string;
  name: string;
  isMember: boolean;
}

export async function coreSlackChannels(): Promise<{ ok: boolean; channels: CoreChannel[]; reason?: string }> {
  const { body } = await call("/internal/v1/slack/channels");
  return body as { ok: boolean; channels: CoreChannel[]; reason?: string };
}

export async function coreChannelMembership(channelId: string): Promise<{ ok: boolean; hasAccess: boolean; name?: string | null; reason?: string }> {
  const { body } = await call(`/internal/v1/slack/membership?channel=${encodeURIComponent(channelId)}`);
  return body as { ok: boolean; hasAccess: boolean; name?: string | null; reason?: string };
}

export interface CoreSlackProfile {
  slackId: string;
  displayName: string | null;
  realName: string | null;
  username: string | null;
  avatarUrl: string | null;
}

// Display identity only — the public name variants and the avatar, nothing
// else (never email). Single-user form; prefer coreUserInfoBatch for a page
// that renders more than one.
export async function coreUserInfo(userId: string): Promise<{ ok: boolean } & Partial<CoreSlackProfile> & { reason?: string }> {
  const { body } = await call(`/internal/v1/slack/users/info?user=${encodeURIComponent(userId)}`);
  return body as { ok: boolean } & Partial<CoreSlackProfile> & { reason?: string };
}

// One round trip for every Slack id a page needs. Core dedupes, caps the
// fan-out, and serves from a per-user cache — a warm dashboard never touches
// Slack. Returns { [id]: profile | null }; null means unknown/deleted/bot.
export async function coreUserInfoBatch(userIds: string[]): Promise<Record<string, CoreSlackProfile | null>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const body = await request<{ users: Record<string, CoreSlackProfile | null> }>(
    "/internal/v1/slack/users/info",
    "identity lookup failed",
    send("POST", { userIds: ids }),
  );
  return body.users ?? {};
}

export async function coreMacrosList(programId: string, q = ""): Promise<unknown[]> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/macros${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    "macros lookup failed",
  );
}

export async function coreMacroSave(programId: string, payload: Record<string, unknown> & { id?: number }): Promise<unknown> {
  if (payload.id) {
    return request(`/internal/v1/macros/${payload.id}`, "macro update failed", send("PATCH", payload));
  }
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/macros`, "macro create failed", send("POST", payload));
}

export async function coreMacroDelete(macroId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/macros/${macroId}`, "macro delete failed", send("DELETE", payload));
}

export async function coreMacroSend(macroId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/macros/${macroId}`, "macro send failed", send("POST", payload));
}

export async function coreAnalytics(programId: string, days = 30): Promise<Record<string, unknown>> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/analytics?days=${days}`, "analytics failed");
}

export async function coreRoutingRecommend(programId: string, category?: string): Promise<unknown[]> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/routing/recommend${category ? `?category=${encodeURIComponent(category)}` : ""}`,
    "routing failed",
  );
}

export type AssignmentLifecycleState = "supported" | "insufficient" | "unsupported";

export interface HelperAssignmentCounts {
  offered: number;
  claimed: number;
  declined: number;
  released: number;
  timedOut: number;
  completedOffers: number;
}

export interface CoreHelperStats {
  programId: string;
  acceptRate: number | null;
  acceptedAssignments: number;
  completedOffers: number;
  assignmentLifecycle: AssignmentLifecycleState;
  helpers: Array<{
    userId: string;
    role: string;
    active: boolean;
    expertise: Array<{ tag: string; solved_count: number }>;
    categoryResolved: Array<{ category: string; resolved: number }>;
    totals: { assigned: number; resolved: number; open: number; reopened: number };
    reopenRate: number | null;
    medianFirstResponseMs: number | null;
    medianResolutionMs: number | null;
    helpfulCount: number;
    unhelpfulCount: number;
    helpfulPercentage: number | null;
    lastActivity: number | null;
    acceptRate: number | null;
    assignmentLifecycle: AssignmentLifecycleState;
    assignments: HelperAssignmentCounts;
    recentTickets: Array<Record<string, unknown>>;
  }>;
}

export async function coreHelperStats(programId: string): Promise<CoreHelperStats> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/helpers/stats`, "helper stats failed");
}

export async function coreRoutingExpertise(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/routing/expertise`,
    "expertise update failed",
    send("PUT", payload),
  );
}

export async function coreDuplicates(programId: string, params: Record<string, string>): Promise<unknown> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/duplicates?${new URLSearchParams(params).toString()}`,
    "duplicates failed",
  );
}

export async function coreIncidents(programId: string, status?: string): Promise<unknown[]> {
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/incidents${status ? `?status=${status}` : ""}`,
    "incidents failed",
  );
}

export async function coreIncidentDetail(incidentId: number): Promise<unknown> {
  return request(`/internal/v1/incidents/${incidentId}`, "incident lookup failed");
}

export async function coreIncidentDetect(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/incidents`, "incident detection failed", send("POST", payload));
}

export async function coreIncidentAction(incidentId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/incidents/${incidentId}`, "incident action failed", send("PATCH", payload));
}

export async function coreIncidentNotify(incidentId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/incidents/${incidentId}/notify`, "incident notify failed", send("POST", payload));
}

export async function coreIncidentAffected(incidentId: number): Promise<{ total: number; unnotified: number; reports: unknown[] }> {
  return request(`/internal/v1/incidents/${incidentId}/affected`, "incident affected-reports failed");
}

export async function coreRadarList(programId: string, params: Record<string, string> = {}): Promise<{ signals: unknown[] }> {
  const query = new URLSearchParams(params).toString();
  return request(
    `/internal/v1/programs/${encodeURIComponent(programId)}/radar${query ? `?${query}` : ""}`,
    "radar list failed",
  );
}

export async function coreRadarEvaluate(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/radar`, "radar evaluate failed", send("POST", payload));
}

export async function coreRadarAction(signalId: number, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/radar/${signalId}`, "radar action failed", send("PATCH", payload));
}

export async function coreHealthScore(programId: string): Promise<Record<string, unknown>> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/health`, "health score failed");
}

export async function coreRetentionPreview(programId: string): Promise<Record<string, unknown>> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/retention`, "retention preview failed");
}

export async function coreRetentionPolicy(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/retention`, "retention update failed", send("PATCH", payload));
}

export async function coreRetentionSweep(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/retention`, "retention sweep failed", send("POST", payload));
}

export async function coreHelpers(programId: string): Promise<unknown[]> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/helpers`, "helpers lookup failed");
}

export async function coreAudit(programId: string): Promise<unknown[]> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/audit?limit=100`, "audit lookup failed");
}

export async function coreHelpersSync(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  return request(`/internal/v1/programs/${encodeURIComponent(programId)}/helpers`, "helpers sync failed", send("PUT", payload));
}
