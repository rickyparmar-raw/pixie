// Pixie Core internal API client (Core lib/web/serve.js /internal/v1/*).
//
// The browser never sees PIXIE_INTERNAL_TOKEN or the Core base URL: every
// function here runs server-side (server actions / route handlers). Core is
// the single writer of runtime state; when it is unreachable the control
// plane still records configuration and marks core_sync_state=pending —
// configured programs keep serving from Core's last-synced state.

const CORE_BASE_URL = (process.env.PIXIE_CORE_BASE_URL || "").replace(/\/+$/, "");
const CORE_TOKEN = process.env.PIXIE_INTERNAL_TOKEN || "";

export function coreConfigured(): boolean {
  return Boolean(CORE_BASE_URL && CORE_TOKEN);
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  if (!coreConfigured()) throw new Error("Pixie Core is not configured (PIXIE_CORE_BASE_URL/PIXIE_INTERNAL_TOKEN)");
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CORE_TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export async function syncProgramToCore(programId: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
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
  const query = new URLSearchParams(params).toString();
  const { status, body } = await call(`/internal/v1/tickets?${query}`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `ticket search failed (${status})`);
  return body as { total: number; rows: unknown[] };
}

export async function coreTicketAction(ticketId: number, action: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/tickets/${ticketId}/${action}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `ticket action failed (${status})`);
  return body;
}

export async function coreTicketReply(ticketId: number, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/tickets/${ticketId}/reply`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `ticket reply failed (${status})`);
  return body;
}

export async function coreTicketDetail(ticketId: number, programId: string): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/tickets/${ticketId}?programId=${encodeURIComponent(programId)}`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `ticket lookup failed (${status})`);
  return body;
}

export async function coreTicketNote(ticketId: number, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/tickets/${ticketId}/notes`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `ticket note failed (${status})`);
  return body;
}

export async function coreKnowledgeCandidates(programId: string, status = "candidate"): Promise<unknown[]> {
  const { status: code, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/knowledge/candidates?status=${encodeURIComponent(status)}`);
  if (code !== 200) throw new Error((body as { error?: string })?.error || `candidates lookup failed (${code})`);
  return body as unknown[];
}

export async function coreKnowledgePropose(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/knowledge/candidates`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `candidate proposal failed (${status})`);
  return body;
}

export async function coreKnowledgeReview(candidateId: number, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/knowledge/candidates/${candidateId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `candidate review failed (${status})`);
  return body;
}

export async function coreGapClusters(programId: string): Promise<{ clusters: unknown[] }> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/gaps/clusters`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `gap clusters failed (${status})`);
  return body as { clusters: unknown[] };
}

export async function coreFaqPropose(programId: string, payload: Record<string, unknown>): Promise<unknown> {  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/gaps/clusters`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `FAQ proposal failed (${status})`);
  return body;
}

export async function coreCopilot(action: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/copilot/${action}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `copilot ${action} failed (${status})`);
  return body;
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

export async function coreMacrosList(programId: string, q = ""): Promise<unknown[]> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/macros${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `macros lookup failed (${status})`);
  return body as unknown[];
}

export async function coreMacroSave(programId: string, payload: Record<string, unknown> & { id?: number }): Promise<unknown> {
  if (payload.id) {
    const { status, body } = await call(`/internal/v1/macros/${payload.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    if (status !== 200) throw new Error((body as { error?: string })?.error || `macro update failed (${status})`);
    return body;
  }
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/macros`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `macro create failed (${status})`);
  return body;
}

export async function coreMacroDelete(macroId: number, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/macros/${macroId}`, {
    method: "DELETE",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `macro delete failed (${status})`);
  return body;
}

export async function coreMacroSend(macroId: number, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/macros/${macroId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `macro send failed (${status})`);
  return body;
}

export async function coreAnalytics(programId: string, days = 30): Promise<Record<string, unknown>> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/analytics?days=${days}`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `analytics failed (${status})`);
  return body as Record<string, unknown>;
}

export async function coreRoutingRecommend(programId: string, category?: string): Promise<unknown[]> {
  const { status, body } = await call(
    `/internal/v1/programs/${encodeURIComponent(programId)}/routing/recommend${category ? `?category=${encodeURIComponent(category)}` : ""}`,
  );
  if (status !== 200) throw new Error((body as { error?: string })?.error || `routing failed (${status})`);
  return body as unknown[];
}

export async function coreRoutingExpertise(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/routing/expertise`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `expertise update failed (${status})`);
  return body;
}

export async function coreDuplicates(programId: string, params: Record<string, string>): Promise<unknown> {
  const query = new URLSearchParams(params).toString();
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/duplicates?${query}`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `duplicates failed (${status})`);
  return body;
}

export async function coreIncidents(programId: string, status?: string): Promise<unknown[]> {
  const { status: code, body } = await call(
    `/internal/v1/programs/${encodeURIComponent(programId)}/incidents${status ? `?status=${status}` : ""}`,
  );
  if (code !== 200) throw new Error((body as { error?: string })?.error || `incidents failed (${code})`);
  return body as unknown[];
}

export async function coreIncidentDetail(incidentId: number): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/incidents/${incidentId}`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `incident lookup failed (${status})`);
  return body;
}

export async function coreIncidentDetect(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/incidents`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `incident detection failed (${status})`);
  return body;
}

export async function coreIncidentAction(incidentId: number, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/incidents/${incidentId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `incident action failed (${status})`);
  return body;
}

export async function coreRetentionPreview(programId: string): Promise<Record<string, unknown>> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/retention`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `retention preview failed (${status})`);
  return body as Record<string, unknown>;
}

export async function coreRetentionPolicy(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/retention`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `retention update failed (${status})`);
  return body;
}

export async function coreRetentionSweep(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/retention`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `retention sweep failed (${status})`);
  return body;
}

export async function coreHelpers(programId: string): Promise<unknown[]> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/helpers`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `helpers lookup failed (${status})`);
  return body as unknown[];
}

export async function coreAudit(programId: string): Promise<unknown[]> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/audit?limit=100`);
  if (status !== 200) throw new Error((body as { error?: string })?.error || `audit lookup failed (${status})`);
  return body as unknown[];
}

export async function coreHelpersSync(programId: string, payload: Record<string, unknown>): Promise<unknown> {
  const { status, body } = await call(`/internal/v1/programs/${encodeURIComponent(programId)}/helpers`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  if (status !== 200) throw new Error((body as { error?: string })?.error || `helpers sync failed (${status})`);
  return body;
}
