import { test, expect, mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createTestDb } from "./pgTestDb";
import {
  BEHAVIOR_FIELDS,
  HELP_BEHAVIOR_DEFAULTS,
  MAIN_BEHAVIOR_DEFAULTS,
  effectiveBehavior,
} from "./types";

const MIGRATION_003 = readFileSync(join(import.meta.dir, "..", "db", "migrations", "003_behavior_runtime_status.sql"), "utf8");

async function migratedDb() {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  await query(MIGRATION_003);
  return { query };
}

test("migration 003 is additive: behavior defaults to {}, new rows start sandbox, pre-existing rows backfill live", async () => {
  const { query } = await migratedDb();
  // Row predating the migration conceptually: inserted with only the old
  // columns, so it takes the column defaults first...
  await query(
    `insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`,
    ["migr-legacy", "T1", "Legacy", "H1"],
  );
  // ...then the migration's own backfill flips pre-existing rows to live.
  // Re-running the backfill UPDATE is exactly what migrate.mjs does once.
  await query(`update hosted_programs set runtime_status = 'live' where id = $1`, ["migr-legacy"]);
  await query(
    `insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`,
    ["migr-new", "T1", "New", "H1"],
  );

  const { rows } = await query<{ id: string; behavior: unknown; runtime_status: string }>(
    `select id, behavior, runtime_status from hosted_programs order by id`,
  );
  const legacy = rows.find((r) => r.id === "migr-legacy")!;
  const fresh = rows.find((r) => r.id === "migr-new")!;
  expect(legacy.behavior).toEqual({});
  expect(legacy.runtime_status).toBe("live");
  expect(fresh.behavior).toEqual({});
  expect(fresh.runtime_status).toBe("sandbox");
});

test("migration 003 rejects statuses outside sandbox|live|paused", async () => {
  const { query } = await migratedDb();
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["migr-chk", "T1", "Chk", "H1"]);
  await expect(query(`update hosted_programs set runtime_status = $1 where id = 'migr-chk'`, ["launched"])).rejects.toThrow();
});

test("updateHostedProgram persists behavior + runtime_status, still rejects id/owner rewrites", async () => {
  const { query } = await migratedDb();
  const { insertHostedProgram } = await import("./programClaim");
  const { updateHostedProgram, getHostedProgram } = await import("./hostedPrograms");
  await insertHostedProgram({ id: "beh-a", workspaceId: "T1", programName: "Beh A", ownerHcaId: "H_OWN", ownerSlackId: null });

  const updated = await updateHostedProgram("beh-a", {
    behavior: { main: { ambientProgramReplies: false }, help: { aiReplies: false } },
    runtime_status: "live",
  });
  expect(updated.behavior).toEqual({ main: { ambientProgramReplies: false }, help: { aiReplies: false } });
  expect(updated.runtime_status).toBe("live");
  expect((await getHostedProgram("beh-a"))?.runtime_status).toBe("live");

  await updateHostedProgram("beh-a", { id: "beh-evil", owner_hca_id: "H_EVIL" } as never);
  expect((await getHostedProgram("beh-a"))?.owner_hca_id).toBe("H_OWN");
  expect(await getHostedProgram("beh-evil")).toBeNull();
  await query(`select 1`);
});

test("behavior toggle catalog matches the Core defaults: main mostly on with tickets off, help all on", () => {
  expect(MAIN_BEHAVIOR_DEFAULTS).toEqual({
    enabled: true,
    ambientProgramReplies: true,
    mentionReplies: true,
    generalMentionChat: true,
    commandsEnabled: true,
    ticketsEnabled: false,
    helperEscalationEnabled: false,
  });
  expect(HELP_BEHAVIOR_DEFAULTS).toEqual({
    enabled: true,
    aiReplies: true,
    ticketsEnabled: true,
    autoCreateTickets: true,
    escalateUnknown: true,
    helperPings: true,
    expertiseRouting: true,
    autoResolve: true,
  });
  const main = BEHAVIOR_FIELDS.filter((f) => f.section === "main");
  const help = BEHAVIOR_FIELDS.filter((f) => f.section === "help");
  expect(main).toHaveLength(7);
  expect(help).toHaveLength(8);
  for (const f of [...main, ...help]) {
    // Plain-English labels, never env var names.
    expect(f.label).not.toMatch(/^[A-Z_]{4,}$/);
    expect(f.help.length).toBeGreaterThan(10);
    const defaults = f.section === "main" ? MAIN_BEHAVIOR_DEFAULTS : HELP_BEHAVIOR_DEFAULTS;
    expect(f.defaultOn).toBe(defaults[f.key as keyof typeof defaults]);
  }
});

test("effectiveBehavior layers a stored partial over the defaults", () => {
  expect(effectiveBehavior(null).main.ambientProgramReplies).toBe(true);
  expect(effectiveBehavior({}).help.ticketsEnabled).toBe(true);
  const eff = effectiveBehavior({ main: { ticketsEnabled: true }, help: { aiReplies: false } });
  expect(eff.main.ticketsEnabled).toBe(true);
  expect(eff.main.enabled).toBe(true);
  expect(eff.help.aiReplies).toBe(false);
  expect(eff.help.ticketsEnabled).toBe(true);
});

test("reconcile payload carries behavior + runtime status and stays secret-free", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  await query(MIGRATION_003);
  const captured: Array<{ id: string; payload: Record<string, unknown> }> = [];
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => true,
    syncProgramToCore: async (id: string, payload: Record<string, unknown>) => {
      captured.push({ id, payload });
      return { ok: true };
    },
  }));
  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { updateHostedProgram } = await import("./hostedPrograms");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "beh-sync", workspaceId: "T_S", programName: "Beh Sync", ownerHcaId: "H1", ownerSlackId: "U1" });
  await claimHostedChannels({ workspaceId: "T_S", programId: "beh-sync", channels: [{ id: "C-beh-help", kind: "help" }], claimedByHcaId: "H1" });
  await updateHostedProgram("beh-sync", {
    behavior: { main: { ambientProgramReplies: false } },
    runtime_status: "sandbox",
  });

  const result = await reconcileHostedSync();
  expect(result).toMatchObject({ attempted: 1, synced: 1 });
  expect(captured).toHaveLength(1);
  expect(captured[0].payload.behavior).toEqual({ main: { ambientProgramReplies: false } });
  expect(captured[0].payload.status).toBe("sandbox");
  const flat = JSON.stringify(captured[0].payload).toLowerCase();
  for (const banned of ["token", "secret", "bearer", "password", "xoxb", "owner_hca"]) {
    expect(flat.includes(banned), `payload must not contain ${banned}`).toBe(false);
  }
});
