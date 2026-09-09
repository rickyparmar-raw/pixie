// Characterization of the WIZARD control plane (Next.js + Postgres).
// Pins the contracts STEP 2's rewrite must preserve: claim atomicity +
// concurrency, ownership/access matrix, public-projection allowlist,
// activation rollback, help-move verify/claim/sync/release/rollback order,
// sync payload shapes, guard persistence, reconcile isolation, $n-param SQL,
// server-side permission on every mutator/management route. Behavioral where
// possible; static only for order/presence the DB double cannot observe.
import { test, expect, mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createTestDb } from "./pgTestDb";
import type { WizardSession } from "./session";

const ROOT = join(import.meta.dir, "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function sess(over: Partial<WizardSession> = {}): WizardSession {
  return { hcaId: "H_OTHER", email: "o@x.com", name: "O", slackId: null, exp: 9999999999, ...over };
}

/* ---------------- claim atomicity + activation rollback ---------------- */

test("failed multi-channel claim leaves zero partial rows (C-free NOT stranded)", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");

  await insertHostedProgram({ id: "char-other", workspaceId: "T_CHAR", programName: "Other", ownerHcaId: "H9", ownerSlackId: null });
  await claimHostedChannels({ workspaceId: "T_CHAR", programId: "char-other", channels: [{ id: "C-char-taken", kind: "help" }], claimedByHcaId: "H9" });
  await insertHostedProgram({ id: "char-new", workspaceId: "T_CHAR", programName: "New", ownerHcaId: "H1", ownerSlackId: null });

  const res = await claimHostedChannels({
    workspaceId: "T_CHAR", programId: "char-new",
    channels: [{ id: "C-char-free", kind: "help" }, { id: "C-char-taken", kind: "discussion" }],
    claimedByHcaId: "H1",
  });
  expect(res.ok).toBe(false);

  const { rows } = await query<{ channel_id: string }>(
    `select channel_id from hosted_program_channels where program_id = $1`, ["char-new"],
  );
  expect(rows).toEqual([]); // nothing partial left for a retry to trip over
  const still = await query<{ program_id: string }>(
    `select program_id from hosted_program_channels where workspace_id = $1 and channel_id = $2`, ["T_CHAR", "C-char-taken"],
  );
  expect(still.rows[0].program_id).toBe("char-other");
});

test("activation rollback contract: program row delete after claim conflict leaves no orphan program or channels", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getHostedProgram } = await import("./hostedPrograms");
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");

  await insertHostedProgram({ id: "char-rb-other", workspaceId: "T_RB", programName: "Other", ownerHcaId: "H9", ownerSlackId: null });
  await claimHostedChannels({ workspaceId: "T_RB", programId: "char-rb-other", channels: [{ id: "C-rb-taken", kind: "help" }], claimedByHcaId: "H9" });
  await insertHostedProgram({ id: "char-rb-new", workspaceId: "T_RB", programName: "New", ownerHcaId: "H1", ownerSlackId: null });
  const claim = await claimHostedChannels({
    workspaceId: "T_RB", programId: "char-rb-new",
    channels: [{ id: "C-rb-taken", kind: "help" }], claimedByHcaId: "H1",
  });
  expect(claim.ok).toBe(false);

  // Same rollback SQL activateHostedProgram runs on claim conflict.
  await query(`delete from hosted_programs where id = $1 and workspace_id = $2`, ["char-rb-new", "T_RB"]);
  expect(await getHostedProgram("char-rb-new")).toBeNull();
  const { rows } = await query(`select * from hosted_program_channels where program_id = $1`, ["char-rb-new"]);
  expect(rows).toEqual([]);
  expect(await getHostedProgram("char-rb-other")).not.toBeNull();
});

test("activateHostedProgram keeps row→claim→rollback order (static)", () => {
  const s = src("app/wizard/hostedActions.ts");
  const fn = s.slice(s.indexOf("export async function activateHostedProgram"), s.indexOf("export async function saveHostedSettings"));
  const iInsert = fn.indexOf("insertHostedProgram");
  const iClaim = fn.indexOf("claimHostedChannels");
  const iRollback = fn.indexOf("delete from hosted_programs");
  expect(iInsert).toBeGreaterThan(-1);
  expect(iClaim).toBeGreaterThan(iInsert);
  expect(iRollback).toBeGreaterThan(iClaim); // unrolled-back partial activation is forbidden
});

test("same channel id in different workspaces does not conflict (tenant isolation)", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  await insertHostedProgram({ id: "char-w1", workspaceId: "T_W1", programName: "W1", ownerHcaId: "H1", ownerSlackId: null });
  await insertHostedProgram({ id: "char-w2", workspaceId: "T_W2", programName: "W2", ownerHcaId: "H2", ownerSlackId: null });
  expect((await claimHostedChannels({ workspaceId: "T_W1", programId: "char-w1", channels: [{ id: "C-shared", kind: "help" }], claimedByHcaId: "H1" })).ok).toBe(true);
  expect((await claimHostedChannels({ workspaceId: "T_W2", programId: "char-w2", channels: [{ id: "C-shared", kind: "help" }], claimedByHcaId: "H2" })).ok).toBe(true);
});

/* ---------------- ownership / access matrix ---------------- */

test("helper of program A is public on program B (no cross-program leakage)", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getHostedProgram } = await import("./hostedPrograms");
  const { relationshipFor } = await import("./programAccess");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["char-pa", "T1", "PA", "H_OWNER_A"]);
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["char-pb", "T1", "PB", "H_OWNER_B"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ($1,$2,'helper',true)`, ["char-pa", "U_XHELP"]);
  const a = await getHostedProgram("char-pa");
  const b = await getHostedProgram("char-pb");
  expect(await relationshipFor(a!, sess({ slackId: "U_XHELP" }))).toBe("helper");
  expect(await relationshipFor(b!, sess({ slackId: "U_XHELP" }))).toBe("public");
});

test("signed-in user with no Slack linkage and no HCA ownership is public", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getHostedProgram } = await import("./hostedPrograms");
  const { relationshipFor } = await import("./programAccess");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["char-nolink", "T1", "NL", "H_OWNER"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ($1,$2,'helper',true)`, ["char-nolink", "U_SOMEONE_ELSE"]);
  const p = await getHostedProgram("char-nolink");
  expect(await relationshipFor(p!, sess({ hcaId: "H_STRANGER", slackId: null }))).toBe("public");
});

test("removed organizer loses admin (inactive rows grant nothing)", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getHostedProgram } = await import("./hostedPrograms");
  const { relationshipFor } = await import("./programAccess");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["char-exorg", "T1", "EO", "H_OWNER"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ($1,$2,'organizer',false)`, ["char-exorg", "U_EXORG"]);
  const p = await getHostedProgram("char-exorg");
  expect(await relationshipFor(p!, sess({ slackId: "U_EXORG" }))).toBe("public");
});

/* ---------------- public projection allowlist ---------------- */

test("public profile SELECT is an allowlist: no owner/settings/sync/secret columns (static)", () => {
  const s = src("lib/hostedPrograms.ts");
  const fn = s.slice(s.indexOf("export async function getPublicProgramProfile"), s.indexOf("export async function listVisibleHelperIdentityKeys"));
  for (const col of ["id", "program_name", "program_description", "support_name", "icon_url", "status", "sources"]) {
    expect(fn.includes(col), `allowlisted column missing: ${col}`).toBe(true);
  }
  for (const banned of ["owner_hca_id", "owner_slack_id", "settings", "core_sync_error", "sensitive_categories", "incident_mode", "public_tickets_enabled", "workspace_id"]) {
    expect(fn.includes(banned), `must not select ${banned} for the public profile`).toBe(false);
  }
});

test("public profile never leaks new settings columns, secrets, or slack ids (behavioral)", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getPublicProgramProfile } = await import("./hostedPrograms");
  await query(
    `insert into hosted_programs (id, workspace_id, program_name, owner_hca_id, owner_slack_id, incident_mode, public_tickets_enabled, core_sync_error, settings, sources)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    ["char-pub", "T1", "Pub", "H_SECRET", "U_SECRET", "NORMAL_TICKET", false,
     "internal sync failure detail", JSON.stringify({ autoAssign: true, secretFlag: 1 }),
     JSON.stringify([{ type: "url", url: "https://x.example.com", public: true }])],
  );
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, visible_on_profile) values ($1,'U_ROSTER','helper',true)`, ["char-pub"]);
  const profile = await getPublicProgramProfile("char-pub");
  const serialized = JSON.stringify(profile);
  for (const secret of ["H_SECRET", "U_SECRET", "U_ROSTER", "internal sync failure detail", "secretFlag", "NORMAL_TICKET"]) {
    expect(serialized.includes(secret), `leaked: ${secret}`).toBe(false);
  }
  expect(profile?.publicSourceCount).toBe(1);
});

test("listVisibleHelperIdentityKeys exposes exactly slackUserId+role for visible active helpers", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { listVisibleHelperIdentityKeys } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["char-keys", "T1", "K", "H1"]);
  await query(
    `insert into hosted_program_helpers (program_id, slack_user_id, role, active, visible_on_profile) values
     ($1,'U_KEEP','helper',true,true), ($1,'U_HIDE','helper',true,false), ($1,'U_GONE','helper',false,true)`,
    ["char-keys"],
  );
  const keys = await listVisibleHelperIdentityKeys("char-keys");
  expect(keys).toEqual([{ slackUserId: "U_KEEP", role: "helper" }]);
  for (const k of keys) expect(Object.keys(k).sort()).toEqual(["role", "slackUserId"]);
});

/* ---------------- help-move verify/claim/sync/release/rollback ---------------- */

test("hostedChannelsUpdate keeps verify→claim→sync→release order with rollback on sync fail (static)", () => {
  const s = src("app/wizard/hostedActions.ts");
  const fn = s.slice(s.indexOf("export async function hostedChannelsUpdate"), s.indexOf("export async function setHelperVisibilityAction"));
  const order = ["coreChannelMembership(rawNew)", "claimHostedChannels({", "syncProgramToCore(programId,", "!sync.ok", "hosted_program_channels"];
  let prev = -1;
  for (const marker of order) {
    const i = fn.indexOf(marker);
    expect(i, `missing step: ${marker}`).toBeGreaterThan(prev);
    prev = i;
  }
  // Both the sync-fail rollback and the old-channel release are scoped to one program's row.
  const scoped = (fn.match(/delete from hosted_program_channels where workspace_id = \$1 and channel_id = \$2 and program_id = \$3/g) || []).length;
  expect(scoped).toBe(2);
  expect(fn.includes("owner_hca_id")).toBe(true); // owner-only move, server-side
});

test("help-move release delete is program-scoped (cannot drop another program's channel)", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { listHostedChannels } = await import("./hostedPrograms");
  await insertHostedProgram({ id: "char-mv-a", workspaceId: "T_MV", programName: "A", ownerHcaId: "H1", ownerSlackId: null });
  await insertHostedProgram({ id: "char-mv-b", workspaceId: "T_MV", programName: "B", ownerHcaId: "H2", ownerSlackId: null });
  await claimHostedChannels({ workspaceId: "T_MV", programId: "char-mv-a", channels: [{ id: "C-mv-old-a", kind: "help" }], claimedByHcaId: "H1" });
  await claimHostedChannels({ workspaceId: "T_MV", programId: "char-mv-b", channels: [{ id: "C-mv-old-b", kind: "help" }], claimedByHcaId: "H2" });

  // Release step for program A only.
  await query(`delete from hosted_program_channels where workspace_id = $1 and channel_id = $2 and program_id = $3`, ["T_MV", "C-mv-old-a", "char-mv-a"]);
  expect((await listHostedChannels("char-mv-a")).map((c) => c.channel_id)).toEqual([]);
  expect((await listHostedChannels("char-mv-b")).map((c) => c.channel_id)).toEqual(["C-mv-old-b"]);
});

test("sync-fail rollback drops only the new claim and keeps old routing", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { listHostedChannels } = await import("./hostedPrograms");
  await insertHostedProgram({ id: "char-rb2", workspaceId: "T_MV2", programName: "R", ownerHcaId: "H1", ownerSlackId: null });
  await claimHostedChannels({ workspaceId: "T_MV2", programId: "char-rb2", channels: [{ id: "C-rb2-old", kind: "help" }], claimedByHcaId: "H1" });
  const claim = await claimHostedChannels({ workspaceId: "T_MV2", programId: "char-rb2", channels: [{ id: "C-rb2-new", kind: "help" }], claimedByHcaId: "H1" });
  expect(claim.ok).toBe(true);

  // Sync failed → rollback SQL from hostedChannelsUpdate.
  await query(`delete from hosted_program_channels where workspace_id = $1 and channel_id = $2 and program_id = $3`, ["T_MV2", "C-rb2-new", "char-rb2"]);
  expect((await listHostedChannels("char-rb2")).map((c) => c.channel_id)).toEqual(["C-rb2-old"]);
});

test("move claim conflict leaves routing exactly as it was", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { listHostedChannels } = await import("./hostedPrograms");
  await insertHostedProgram({ id: "char-mv-c", workspaceId: "T_MV3", programName: "C", ownerHcaId: "H1", ownerSlackId: null });
  await insertHostedProgram({ id: "char-mv-d", workspaceId: "T_MV3", programName: "D", ownerHcaId: "H2", ownerSlackId: null });
  await claimHostedChannels({ workspaceId: "T_MV3", programId: "char-mv-c", channels: [{ id: "C-mv3-old", kind: "help" }], claimedByHcaId: "H1" });
  await claimHostedChannels({ workspaceId: "T_MV3", programId: "char-mv-d", channels: [{ id: "C-mv3-taken", kind: "help" }], claimedByHcaId: "H2" });

  const claim = await claimHostedChannels({ workspaceId: "T_MV3", programId: "char-mv-c", channels: [{ id: "C-mv3-taken", kind: "help" }], claimedByHcaId: "H1" });
  expect(claim.ok).toBe(false);
  expect((await listHostedChannels("char-mv-c")).map((c) => c.channel_id)).toEqual(["C-mv3-old"]);
});

/* ---------------- sync payload shapes ---------------- */

test("reconcile payload carries full config incl. incidentMode/publicTicketsEnabled, no secrets", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const captured: Array<{ id: string; payload: Record<string, unknown> }> = [];
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => true,
    syncProgramToCore: async (id: string, payload: Record<string, unknown>) => {
      captured.push({ id, payload });
      return { ok: true };
    },
  }));
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { updateHostedProgram, getHostedProgram } = await import("./hostedPrograms");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "char-sync", workspaceId: "T_SYNC", programName: "Sync Me", ownerHcaId: "H1", ownerSlackId: "U1" });
  await claimHostedChannels({
    workspaceId: "T_SYNC", programId: "char-sync",
    channels: [
      { id: "C-sync-help", kind: "help" },
      { id: "C-sync-org", kind: "organizer" },
      { id: "C-sync-extra", kind: "discussion" },
    ],
    claimedByHcaId: "H1",
  });
  await updateHostedProgram("char-sync", {
    incident_mode: "NORMAL_TICKET",
    public_tickets_enabled: false,
    sources: [{ type: "url", url: "https://docs.example.com" }],
    settings: { autoAssign: true },
  } as never);

  const result = await reconcileHostedSync();
  expect(result).toMatchObject({ attempted: 1, synced: 1, stillFailed: 0 });
  expect(captured).toHaveLength(1);
  const p = captured[0].payload;
  expect(p.name).toBe("Sync Me");
  expect(p.workspaceId).toBe("T_SYNC");
  expect(p.helpChannel).toBe("C-sync-help");
  expect(p.channels).toEqual(expect.arrayContaining(["C-sync-help", "C-sync-org", "C-sync-extra"]));
  expect(p.incidentMode).toBe("NORMAL_TICKET");
  expect(p.publicTicketsEnabled).toBe(false);
  expect(p.autoAssign).toBe(true);
  expect(p.claimedBy).toBe("U1");
  expect(p.programChannels).toEqual(expect.arrayContaining([{ id: "C-sync-help", kind: "help" }]));
  const flat = JSON.stringify(p).toLowerCase();
  for (const banned of ["token", "secret", "bearer", "password", "xoxb", "owner_hca"]) {
    expect(flat.includes(banned), `payload must not contain ${banned}`).toBe(false);
  }
  expect((await getHostedProgram("char-sync"))?.core_sync_state).toBe("synced");
});

test("reconcile isolates failures: one bad program never blocks the rest", async () => {
  mock.module("@/lib/db", () => createTestDb());
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => true,
    syncProgramToCore: async (id: string) =>
      id === "char-iso-bad" ? { ok: false, error: "boom" } : { ok: true },
  }));
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { getHostedProgram } = await import("./hostedPrograms");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "char-iso-bad", workspaceId: "T_ISO", programName: "Bad", ownerHcaId: "H1", ownerSlackId: null });
  await claimHostedChannels({ workspaceId: "T_ISO", programId: "char-iso-bad", channels: [{ id: "C-iso-bad", kind: "help" }], claimedByHcaId: "H1" });
  await insertHostedProgram({ id: "char-iso-good", workspaceId: "T_ISO", programName: "Good", ownerHcaId: "H1", ownerSlackId: null });
  await claimHostedChannels({ workspaceId: "T_ISO", programId: "char-iso-good", channels: [{ id: "C-iso-good", kind: "help" }], claimedByHcaId: "H1" });

  const result = await reconcileHostedSync();
  expect(result.attempted).toBe(2);
  expect(result.synced).toBe(1);
  expect(result.stillFailed).toBe(1);
  expect(result.errors).toEqual([{ programId: "char-iso-bad", error: "boom" }]);
  expect((await getHostedProgram("char-iso-good"))?.core_sync_state).toBe("synced");
  expect((await getHostedProgram("char-iso-bad"))?.core_sync_state).toBe("failed");
});

/* ---------------- guard persistence + update allowlist ---------------- */

test("updateHostedProgram persists incident_mode/public_tickets_enabled, rejects id/owner rewrites", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { insertHostedProgram } = await import("./programClaim");
  const { updateHostedProgram, getHostedProgram } = await import("./hostedPrograms");
  await insertHostedProgram({ id: "char-allow", workspaceId: "T_AL", programName: "Allow", ownerHcaId: "H_OWN", ownerSlackId: null });

  const updated = await updateHostedProgram("char-allow", { incident_mode: "ANSWER_ONLY", public_tickets_enabled: false } as never);
  expect(updated.incident_mode).toBe("ANSWER_ONLY");
  expect(updated.public_tickets_enabled).toBe(false);

  // IDOR-relevant: id / owner_hca_id are INSERT-only, never patchable.
  await updateHostedProgram("char-allow", { id: "char-evil", owner_hca_id: "H_EVIL", support_name: "Renamed" } as never);
  const row = await getHostedProgram("char-allow");
  expect(row?.owner_hca_id).toBe("H_OWN");
  expect(row?.support_name).toBe("Renamed");
  expect(await getHostedProgram("char-evil")).toBeNull();
});

/* ---------------- SQL parameterization + server-side permission ---------------- */

test("all SQL templates in lib + hostedActions are $n-parameterized (no value interpolation)", () => {
  for (const rel of ["lib/hostedPrograms.ts", "lib/programClaim.ts", "app/wizard/hostedActions.ts"]) {
    const text = src(rel);
    const templates = [...text.matchAll(/`[^`]*`/gs)].map((m) => m[0])
      .filter((t) => /\b(select|insert|update|delete)\b/i.test(t) && /\b(from|where|set|values)\b/i.test(t));
    expect(templates.length, `${rel} should contain SQL templates`).toBeGreaterThan(0);
    for (const t of templates) {
      for (const m of t.matchAll(/\$\{([^}]*)\}/g)) {
        const inner = m[1];
        expect(/sets\.join|params\.length|^\s*col\s*$/.test(inner), `${rel} interpolates ${inner} into SQL`).toBe(true);
      }
      // No $1-style placeholder bypass via string concat of values either.
      expect(/\$\{\s*(programId|channelId|workspaceId|ownerHca|session|input)/.test(t), `${rel} interpolates a value into SQL`).toBe(false);
    }
  }
});

test("every management page gates server-side with requireProgramMembership (static)", () => {
  const pages = [
    "app/programs/[id]/tickets/page.tsx",
    "app/programs/[id]/tickets/[ticketId]/page.tsx",
    "app/programs/[id]/knowledge/page.tsx",
    "app/programs/[id]/gaps/page.tsx",
    "app/programs/[id]/macros/page.tsx",
    "app/programs/[id]/helpers/page.tsx",
    "app/programs/[id]/analytics/page.tsx",
    "app/programs/[id]/incidents/page.tsx",
    "app/programs/[id]/incidents/[incidentId]/page.tsx",
    "app/programs/[id]/audit/page.tsx",
    "app/programs/[id]/retention/page.tsx",
    "app/programs/[id]/radar/page.tsx",
  ];
  for (const p of pages) {
    expect(src(p).includes("requireProgramMembership"), `${p} must gate server-side`).toBe(true);
  }
});

test("hostedActions mutators are server-authorized, never UI-only (static)", () => {
  const s = src("app/wizard/hostedActions.ts");
  expect(s.includes('"use server"')).toBe(true);
  // Owner-exclusive config paths check ownership server-side.
  for (const fn of ["saveHostedSettings", "saveHostedSources"]) {
    const body = s.slice(s.indexOf(`export async function ${fn}`), s.indexOf(`export async function ${fn}`) + 1200);
    expect(body.includes("requireProgramOwner"), `${fn} must requireProgramOwner`).toBe(true);
  }
  // Display-only roster toggle is owner-or-admin, still server-side.
  const vis = s.slice(s.indexOf("export async function setHelperVisibilityAction"));
  expect(vis.includes("requireProgramOwnerOrAdmin")).toBe(true);

  // Managing a program you already own must NOT require the creator allowlist —
  // that gate (requireHostedSession / creatorEligible) is creation-only.
  const ownerGuard = s.slice(s.indexOf("async function requireProgramOwner("), s.indexOf("async function requireProgramOwnerOrAdmin"));
  expect(ownerGuard.includes("requireHostedSession"), "requireProgramOwner must not go through the creator gate").toBe(false);
  expect(ownerGuard.includes("owner_hca_id"), "requireProgramOwner authorizes by program ownership").toBe(true);
  const creationGuard = s.slice(s.indexOf("async function requireHostedSession"), s.indexOf("async function requireProgramOwner("));
  expect(creationGuard.includes("creatorEligible"), "creation still gated by the creator allowlist").toBe(true);
  // Bearer token never leaves the server client: no token literal in client components.
  for (const c of [
    "app/programs/[id]/incidents/IncidentControls.tsx",
    "app/programs/[id]/radar/RadarControls.tsx",
    "app/programs/[id]/tickets/[ticketId]/TicketActions.tsx",
  ]) {
    const text = src(c).toLowerCase();
    expect(text.includes("pixie_internal_token"), `${c} must not touch the Core token`).toBe(false);
    expect(text.includes("xoxb-"), `${c} must not contain tokens`).toBe(false);
  }
  expect(src("lib/pixieCore.ts").includes("NEXT_PUBLIC")).toBe(false);
});
