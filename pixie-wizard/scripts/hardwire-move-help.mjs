// Move Hardwire's help channel. Mirrors app/wizard/hostedActions.ts
// hostedChannelsUpdate: verify Pixie access -> claim new (Postgres + Core) ->
// release old, with the organizer claim and all program config untouched.
// Ticket history keeps old channel ids; only live routing moves.
//
//   node scripts/hardwire-move-help.mjs            # dry-run
//   node scripts/hardwire-move-help.mjs --apply
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const DB_URL = req("DATABASE_URL");
const CORE_URL = req("PIXIE_CORE_BASE_URL").replace(/\/+$/, "");
const CORE_TOKEN = req("PIXIE_INTERNAL_TOKEN");
const WS = (process.env.PIXIE_WORKSPACE_ID || "default").trim() || "default";
function req(n) { const v = process.env[n]; if (!v) throw new Error(`${n} not set`); return v; }

const SLUG = "hardwire";
const NEW_HELP = "C0C0BGHE4JJ";       // #hardwire-pixie-test (private, Pixie is a member)
const OLD_HELP = "C0BK9C320KH";       // #hardwire-support
const ORGANIZER = "C0BV468JJMV";      // #hardwire-support-tix (unchanged)
const OWNER_HCA = "ident!rrfO4b";
const OWNER_SLACK = "U0A1VPETCR3";

const pool = new Pool({ connectionString: DB_URL, ssl: /sslmode=require/.test(DB_URL) ? { rejectUnauthorized: false } : undefined });
const q = (t, p = []) => pool.query(t, p).then((r) => r.rows);
async function core(path, init) {
  const res = await fetch(`${CORE_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${CORE_TOKEN}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  // preflight: new channel not owned by another program
  const owner = (await q(`select program_id, kind from hosted_program_channels where workspace_id=$1 and channel_id=$2`, [WS, NEW_HELP]))[0];
  if (owner && owner.program_id !== SLUG) { console.log(`ABORT: ${NEW_HELP} owned by ${owner.program_id}`); process.exit(1); }

  // Pixie membership on the new channel (same gate hostedChannelsUpdate uses)
  const mem = await core(`/internal/v1/slack/membership?channel=${NEW_HELP}`, {});
  console.log(`Pixie membership on ${NEW_HELP}:`, JSON.stringify(mem.body));
  if (!(mem.body && mem.body.ok && mem.body.hasAccess)) { console.log("ABORT: Pixie is not in the new help channel — /invite @Pixie there first."); process.exit(1); }

  const cur = await q(`select channel_id, kind from hosted_program_channels where program_id=$1 order by kind`, [SLUG]);
  console.log("current hardwire channels:", JSON.stringify(cur));

  if (!APPLY) { console.log(`\nplan: help ${OLD_HELP} -> ${NEW_HELP}  (organizer ${ORGANIZER} unchanged)`); await pool.end(); return; }

  // -- Postgres: claim new help, release old (one txn) --
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `insert into hosted_program_channels (workspace_id, channel_id, program_id, kind, claimed_by_hca_id)
       values ($1,$2,$3,'help',$4)
       on conflict (workspace_id, channel_id) do update set kind='help', program_id=excluded.program_id`,
      [WS, NEW_HELP, SLUG, OWNER_HCA],
    );
    await client.query(`delete from hosted_program_channels where workspace_id=$1 and channel_id=$2 and program_id=$3`, [WS, OLD_HELP, SLUG]);
    await client.query(
      `insert into hosted_audit_events (program_id, actor_hca_id, actor_slack_id, action, entity_type, entity_id, metadata)
       values ($1,$2,$3,'program.help_channel_moved','program',$1,$4::jsonb)`,
      [SLUG, OWNER_HCA, OWNER_SLACK, JSON.stringify({ from: OLD_HELP, to: NEW_HELP, via: "hardwire-move-help.mjs" })],
    );
    await client.query("COMMIT");
    console.log("Postgres: committed");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.log("ROLLBACK:", e.message); process.exit(1); }
  finally { client.release(); }

  // -- Core: full program re-sync with the channel move --
  const payload = {
    name: "Hardwire",
    workspaceId: WS, workspace_id: WS,
    supportName: "Mr.wire",
    helpChannel: NEW_HELP,
    channels: [NEW_HELP, ORGANIZER],
    posture: "active", scope: "program",
    aiAnswers: true, ticketsEnabled: true, autoEscalate: true,
    incidentMode: "ANSWER_AND_TRACK", publicTicketsEnabled: true, autoAssign: false,
    claimedBy: OWNER_SLACK,
    programChannels: [
      { id: NEW_HELP, kind: "help" },
      { id: ORGANIZER, kind: "organizer" },
      { id: OLD_HELP, kind: "release" },
    ],
  };
  const s = await core(`/internal/v1/programs/${SLUG}`, { method: "PUT", body: JSON.stringify(payload) });
  console.log(`Core sync: HTTP ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`);
  if (s.status < 200 || s.status >= 300) {
    await q(`update hosted_programs set core_sync_state='failed', core_sync_error=$2 where id=$1`, [SLUG, JSON.stringify(s.body).slice(0, 400)]);
    process.exit(1);
  }
  await q(`update hosted_programs set core_sync_state='synced', core_sync_error=null, core_synced_at=now() where id=$1`, [SLUG]);

  // -- verify --
  console.log("\n=== VERIFY (Postgres) ===");
  console.table(await q(`select channel_id, kind from hosted_program_channels where program_id=$1 order by kind`, [SLUG]));
  console.log("=== VERIFY (Core) ===");
  const cp = await core(`/internal/v1/programs`, {});
  const hw = (Array.isArray(cp.body) ? cp.body : cp.body.programs || []).find((p) => p.id === SLUG);
  console.log(JSON.stringify({ helpChannel: hw?.helpChannel, channels: hw?.channels }));
  await pool.end();
  console.log("\nDONE.");
}
main().catch((e) => { console.error(e); process.exit(1); });
