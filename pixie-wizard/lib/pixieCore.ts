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
