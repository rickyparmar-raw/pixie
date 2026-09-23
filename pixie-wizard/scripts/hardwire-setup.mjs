// One-off Hardwire onboarding. Mirrors the canonical wizard/control-plane
// functions (lib/programClaim.ts insertHostedProgram / claimHostedChannels,
// lib/hostedPrograms.ts updateHostedProgram / addHostedHelper / logHostedAudit /
// markSyncState) and the canonical Core sync contract (lib/pixieCore.ts
// syncProgramToCore -> PUT /internal/v1/programs/:id, coreHelpersSync ->
// PUT /internal/v1/programs/:id/helpers).
//
// Runs inside the pixie-wizard container (needs DATABASE_URL, PIXIE_CORE_BASE_URL,
// PIXIE_INTERNAL_TOKEN, PIXIE_WORKSPACE_ID). Idempotent: safe to re-run.
//
//   node scripts/hardwire-setup.mjs           # dry-run: inspect + plan only
//   node scripts/hardwire-setup.mjs --apply   # execute
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const DB_URL = req("DATABASE_URL");
const CORE_URL = req("PIXIE_CORE_BASE_URL").replace(/\/+$/, "");
const CORE_TOKEN = req("PIXIE_INTERNAL_TOKEN");
const WORKSPACE = (process.env.PIXIE_WORKSPACE_ID || "").trim() || "default";

function req(n) { const v = process.env[n]; if (!v) throw new Error(`${n} not set`); return v; }

// ---- Hardwire configuration -------------------------------------------------
const SLUG = "hardwire";
const PROGRAM_NAME = "Hardwire";
const SUPPORT_NAME = "Mr.wire";
const DESCRIPTION =
  "Hardwire is a Hack Club YSWS that guides teens (13-18) through the semiconductor pipeline across three tiers: " +
  "T1 Digital Logic (iCE40 FPGA board), T2 ASIC Tapeout (ASIC shuttle slot), and T3 Custom Carrier Board (PCB fab & test components).";
const OWNER_HCA_ID = "ident!rrfO4b";   // Ricky (matches pixie-sandbox-e2e owner)
const OWNER_SLACK_ID = "U0A1VPETCR3";  // Ricky

const HELP_CHANNEL = "C0BK9C320KH";       // #hardwire-support
const ORGANIZER_CHANNEL = "C0BV468JJMV";  // #hardwire-support-tix (private)

// Only these two are claimed. #hardwire (C0BF8115UJK) and #hardwire-bulletin
// (C0BKNPFMK54) are deliberately left unclaimed.
const CHANNELS = [
  { id: HELP_CHANNEL, kind: "help" },
  { id: ORGANIZER_CHANNEL, kind: "organizer" },
];

const HELPERS = [
  { slack: "U0A1VPETCR3", role: "owner", source: "creator" },      // Ricky — setup owner
  { slack: "U0B6FDY0NDB", role: "organizer", source: "manual" },   // Cal Loftus — program admin
  { slack: "U0ABRTX4BDF", role: "helper", source: "manual" },      // migrantor main
  { slack: "U0A1ABVN50D", role: "helper", source: "manual" },      // lowpolyphosphorus
  { slack: "U0B19TZKXFX", role: "helper", source: "manual" },      // Anna B
];
const CORE_HELPER_MEMBERS = ["U0B6FDY0NDB", "U0ABRTX4BDF", "U0A1ABVN50D", "U0B19TZKXFX"]; // Ricky added by claimedBy

const GH = "https://api.github.com/repos/sectersion/hardwire/contents/apps/web/content/docs";
const SOURCES = [
  { type: "github-dir", name: "Hardwire Docs - Getting Started", url: `${GH}/01-getting-started` },
  { type: "github-dir", name: "Hardwire Docs - Tiers Overview", url: `${GH}/02-tiers` },
  { type: "github-dir", name: "Hardwire Docs - T1 Digital Logic", url: `${GH}/02-tiers/t1-digital-logic` },
  { type: "github-dir", name: "Hardwire Docs - T2 ASIC Tapeout", url: `${GH}/02-tiers/t2-asic-tapeout` },
  { type: "github-dir", name: "Hardwire Docs - T3 Custom Carrier Board", url: `${GH}/02-tiers/t3-custom-carrier-board` },
  { type: "gdoc", name: "Hardwire Program Overview (README)", url: "https://raw.githubusercontent.com/sectersion/hardwire/main/README.md" },
  // Name-collides with the shared ysws-global "Quick Links" (Pixl's quick-links.json)
  // on purpose: knowledge.js sourceSections() dedupes by display name with the
  // program source first, so this shadows the Pixl one out of Hardwire's corpus
  // and retrieval index. Content is verbatim from Hardwire's own
  // apps/web/content/docs/01-getting-started/02-resources.md — nothing invented.
  {
    type: "json-faq",
    name: "Quick Links",
    content: [
      { question: "Where do I ask Hardwire questions / where is the Hardwire community?", answer: "In the Hack Club Slack #hardwire channel: https://hackclub.enterprise.slack.com/archives/C0BF8115UJK" },
      { question: "Where do I download KiCad for T3?", answer: "KiCad is free, open-source PCB design software and is needed for T3: https://www.kicad.org/download/" },
      { question: "I'm new to Verilog / VHDL — where should I start?", answer: "Start with the Verilog / VHDL primer on HDLBits before diving into T1: https://hdlbits.01xz.net/wiki/Main_Page" },
    ],
  },
];

const SETTINGS = { description: DESCRIPTION, autoAssign: false, sharedSources: false };

// ---- Core sync payload (mirrors hostedReconcile.ts buildSyncPayload) --------
const CORE_PAYLOAD = {
  name: PROGRAM_NAME,
  description: DESCRIPTION,
  workspaceId: WORKSPACE,
  workspace_id: WORKSPACE,
  supportName: SUPPORT_NAME,
  iconUrl: null,
  helpChannel: HELP_CHANNEL,
  channels: CHANNELS.map((c) => c.id),
  posture: "active",
  scope: "program",
  aiAnswers: true,
  ticketsEnabled: true,
  autoEscalate: true,
  incidentMode: "ANSWER_AND_TRACK",
  publicTicketsEnabled: true,
  sharedSources: false,
  autoAssign: false,
  sources: SOURCES,
  claimedBy: OWNER_SLACK_ID,
  programChannels: CHANNELS,
};

const pool = new Pool({ connectionString: DB_URL, ssl: /sslmode=require/.test(DB_URL) ? { rejectUnauthorized: false } : undefined });
const q = (t, p = []) => pool.query(t, p).then((r) => r.rows);

async function coreCall(path, init) {
  const res = await fetch(`${CORE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CORE_TOKEN}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function line(x) { console.log(x); }

async function main() {
  line(`\n=== Hardwire onboarding ${APPLY ? "(APPLY)" : "(dry-run — pass --apply to execute)"} ===`);
  line(`workspace=${WORKSPACE}  slug=${SLUG}  core=${CORE_URL}`);

  // -- preflight: channel-claim conflicts --
  const conflicts = await q(
    `select channel_id, program_id, kind from hosted_program_channels
     where workspace_id = $1 and channel_id = any($2) and program_id <> $3`,
    [WORKSPACE, CHANNELS.map((c) => c.id), SLUG],
  );
  if (conflicts.length) {
    line(`ABORT: channels already claimed by another program: ${JSON.stringify(conflicts)}`);
    process.exit(1);
  }
  line("preflight: no cross-program channel conflicts");

  if (!APPLY) {
    line("\nplanned Postgres writes:");
    line(`  hosted_programs: upsert id=${SLUG} owner_hca_id=${OWNER_HCA_ID} owner_slack_id=${OWNER_SLACK_ID}`);
    line(`  config: support_name=${SUPPORT_NAME} ai_answers=t tickets_enabled=t auto_escalate=t posture=active scope=program`);
    line(`  hosted_program_channels: ${CHANNELS.map((c) => `${c.id}:${c.kind}`).join("  ")}`);
    line(`  hosted_program_helpers: ${HELPERS.map((h) => `${h.slack}:${h.role}/${h.source}`).join("  ")}`);
    line(`  sources (${SOURCES.length}): ${SOURCES.map((s) => s.name).join(" | ")}`);
    line("\nplanned Core calls:");
    line(`  PUT /internal/v1/programs/${SLUG}   (create + claim help/organizer + Ricky as creator/organizer helper)`);
    line(`  PUT /internal/v1/programs/${SLUG}/helpers   members=${JSON.stringify(CORE_HELPER_MEMBERS)}`);
    await pool.end();
    return;
  }

  // -- 1. Postgres, one transaction --
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // insertHostedProgram (idempotent)
    await client.query(
      `insert into hosted_programs (id, workspace_id, program_name, program_description, owner_hca_id, owner_slack_id, deployment_mode, status, settings)
       values ($1,$2,$3,$4,$5,$6,'hosted_shared','active',$7::jsonb)
       on conflict (id) do nothing`,
      [SLUG, WORKSPACE, PROGRAM_NAME, DESCRIPTION, OWNER_HCA_ID, OWNER_SLACK_ID, JSON.stringify({ description: DESCRIPTION })],
    );

    // updateHostedProgram — only columns that exist in this DB
    await client.query(
      `update hosted_programs set
         program_name = $2, program_description = $3, support_name = $4, icon_url = null,
         ai_answers = true, tickets_enabled = true, auto_escalate = true,
         posture = 'active', scope = 'program',
         sources = $5::jsonb, settings = $6::jsonb, updated_at = now()
       where id = $1`,
      [SLUG, PROGRAM_NAME, DESCRIPTION, SUPPORT_NAME, JSON.stringify(SOURCES), JSON.stringify(SETTINGS)],
    );

    // claimHostedChannels — per-channel conflict check inside the txn, then claim
    for (const ch of CHANNELS) {
      const owner = (await client.query(
        `select program_id, kind from hosted_program_channels where workspace_id = $1 and channel_id = $2`,
        [WORKSPACE, ch.id],
      )).rows[0];
      if (owner && owner.program_id !== SLUG) throw new Error(`channel ${ch.id} owned by ${owner.program_id}`);
      if (owner && owner.kind !== ch.kind) {
        await client.query(
          `update hosted_program_channels set kind = $3 where workspace_id = $1 and channel_id = $2`,
          [WORKSPACE, ch.id, ch.kind],
        );
      } else if (!owner) {
        await client.query(
          `insert into hosted_program_channels (workspace_id, channel_id, program_id, kind, claimed_by_hca_id)
           values ($1,$2,$3,$4,$5)`,
          [WORKSPACE, ch.id, SLUG, ch.kind, OWNER_HCA_ID],
        );
      }
    }

    // addHostedHelper
    for (const h of HELPERS) {
      await client.query(
        `insert into hosted_program_helpers (program_id, slack_user_id, role, helper_source, active)
         values ($1,$2,$3,$4,true)
         on conflict (program_id, slack_user_id)
         do update set role = excluded.role, helper_source = excluded.helper_source, active = true, removed_at = null`,
        [SLUG, h.slack, h.role, h.source],
      );
    }

    // logHostedAudit
    await client.query(
      `insert into hosted_audit_events (program_id, actor_hca_id, actor_slack_id, action, entity_type, entity_id, metadata)
       values ($1,$2,$3,'program.activated','program',$1,$4::jsonb)`,
      [SLUG, OWNER_HCA_ID, OWNER_SLACK_ID, JSON.stringify({ via: "hardwire-setup.mjs", channels: CHANNELS, sourcesCount: SOURCES.length, helpersCount: HELPERS.length })],
    );

    await client.query("COMMIT");
    line("Postgres: committed");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    line(`Postgres: ROLLED BACK — ${e.message}`);
    process.exit(1);
  } finally {
    client.release();
  }

  // -- 2. Core sync (canonical PUT /internal/v1/programs/:id) --
  const sync = await coreCall(`/internal/v1/programs/${SLUG}`, { method: "PUT", body: JSON.stringify(CORE_PAYLOAD) });
  line(`Core program sync: HTTP ${sync.status} ${JSON.stringify(sync.body).slice(0, 200)}`);
  if (sync.status < 200 || sync.status >= 300) {
    await q(`update hosted_programs set core_sync_state='failed', core_sync_error=$2 where id=$1`, [SLUG, JSON.stringify(sync.body).slice(0, 500)]);
    line("markSyncState: failed");
    process.exit(1);
  }
  await q(`update hosted_programs set core_sync_state='synced', core_sync_error=null, core_synced_at=now() where id=$1`, [SLUG]);
  line("markSyncState: synced");

  // -- 3. Core helper membership for the 4 Hardwire organizers --
  const hsync = await coreCall(`/internal/v1/programs/${SLUG}/helpers`, {
    method: "PUT",
    body: JSON.stringify({ actorId: OWNER_SLACK_ID, members: CORE_HELPER_MEMBERS, source: "manual" }),
  });
  line(`Core helpers sync: HTTP ${hsync.status} ${JSON.stringify(hsync.body).slice(0, 300)}`);

  // -- 4. verification --
  line("\n=== VERIFY: Postgres ===");
  line(JSON.stringify((await q(`select id, workspace_id, program_name, support_name, owner_hca_id, owner_slack_id, status, ai_answers, tickets_enabled, auto_escalate, posture, scope, core_sync_state, core_synced_at, jsonb_array_length(sources) n_sources from hosted_programs where id=$1`, [SLUG]))[0], null, 2));
  console.table(await q(`select workspace_id, channel_id, program_id, kind from hosted_program_channels where program_id=$1 order by kind`, [SLUG]));
  console.table(await q(`select slack_user_id, role, helper_source, active from hosted_program_helpers where program_id=$1 order by role, slack_user_id`, [SLUG]));

  line("\n=== VERIFY: Core ===");
  const cp = await coreCall(`/internal/v1/programs`, {});
  const list = Array.isArray(cp.body) ? cp.body : cp.body.programs || [];
  const hw = list.find((p) => p.id === SLUG);
  line(`Core program hardwire: ${JSON.stringify(hw && { id: hw.id, name: hw.name, workspaceId: hw.workspaceId, supportName: hw.supportName, posture: hw.posture, scope: hw.scope, aiAnswers: hw.aiAnswers, ticketsEnabled: hw.ticketsEnabled, autoEscalate: hw.autoEscalate, publicTicketsEnabled: hw.publicTicketsEnabled, incidentMode: hw.incidentMode, deploymentMode: hw.deploymentMode, helpChannel: hw.helpChannel, channels: hw.channels, nSources: (hw.sources || []).length })}`);
  const ch = await coreCall(`/internal/v1/programs/${SLUG}/helpers`, {});
  line(`Core helpers: ${JSON.stringify(ch.body)}`);

  await pool.end();
  line("\nDONE.");
}

main().catch((e) => { console.error(e); process.exit(1); });
