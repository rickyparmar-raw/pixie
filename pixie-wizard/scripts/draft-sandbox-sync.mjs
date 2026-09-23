import { Pool } from "pg";

const CORE_URL = required("PIXIE_CORE_BASE_URL").replace(/\/+$/, "");
const CORE_TOKEN = required("PIXIE_INTERNAL_TOKEN");
const DB_URL = required("DATABASE_URL");
const WORKSPACE = process.env.PIXIE_WORKSPACE_ID || "default";
// Jame Gam is a live production-scoped program now. Keep only genuinely
// Keep the suspended Live YSWS draft synchronized into its private sandbox.
// Live is now promoted to production on its existing private help/ticket channels.
// Keep it out of the draft sync loop so the sandbox cannot be rebound.
const ids = [];

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name];
}

const pool = new Pool({ connectionString: DB_URL, ssl: /sslmode=require/.test(DB_URL) ? { rejectUnauthorized: false } : undefined });

async function sync(id) {
  const { rows } = await pool.query("select * from hosted_programs where id = $1", [id]);
  const row = rows[0];
  if (!row) throw new Error(`${id} draft is missing`);
  if (row.status !== "suspended" || row.posture !== "muted" || row.tickets_enabled || row.auto_escalate) throw new Error(`${id} draft safety flags are invalid`);
  const settings = row.settings || {};
  const channels = settings.plannedPrivateChannels || {};
  const bindings = Object.entries(channels).map(([role, channelId]) => ({ channelId, role: role === "tickets" ? "ticket" : "help", sandboxOnly: true, enabled: true }));
  const payload = {
    id,
    name: row.program_name,
    status: row.status,
    privateSandboxOnly: settings.privateSandboxOnly === true,
    workspaceId: WORKSPACE,
    sources: row.sources || [],
    faqContent: "",
    sandboxBindings: bindings,
    autoAssign: false,
    ticketsEnabled: false,
  };
  if (!payload.privateSandboxOnly) throw new Error(`${id} is not privateSandboxOnly`);
  const response = await fetch(`${CORE_URL}/internal/v1/drafts/${encodeURIComponent(id)}/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CORE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ draft: payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status} ${result.error || "sync failed"}`);
  return { id, status: row.status, sourceCount: result.sources, chunkCount: result.chunks, faqCount: result.faq, skipped: result.skipped, bindings: result.bindings };
}

try {
  const results = [];
  for (const id of ids) results.push(await sync(id));
  console.log(JSON.stringify({ results }, null, 2));
} finally {
  await pool.end();
}
