import { test, expect, mock } from "bun:test";
import { createTestDb } from "./pgTestDb";

// Each test re-registers its own fresh fake: mock.module patches the module
// registry for the whole process, and this reconciler intentionally scans
// ALL not-synced programs with no workspace filter (that's the point — a
// global sweep), so tests sharing one fake would see each other's leftover
// pending rows. A fresh fake per test keeps them isolated the same way a
// real per-test transaction rollback would.

test("reconciles pending programs and marks them synced", async () => {
  mock.module("@/lib/db", () => createTestDb());
  let coreLive = true;
  const synced: string[] = [];
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => coreLive,
    syncProgramToCore: async (id: string) => {
      synced.push(id);
      return { ok: coreLive };
    },
  }));

  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "recon-a", workspaceId: "T1", programName: "Recon A", ownerHcaId: "H1", ownerSlackId: "U1" });
  await claimHostedChannels({ workspaceId: "T1", programId: "recon-a", channels: [{ id: "C-help", kind: "help" }], claimedByHcaId: "H1" });

  const result = await reconcileHostedSync();
  expect(result.attempted).toBe(1);
  expect(result.synced).toBe(1);
  expect(result.stillFailed).toBe(0);
  expect(synced).toEqual(["recon-a"]);

  const { getHostedProgram } = await import("./hostedPrograms");
  const program = await getHostedProgram("recon-a");
  expect(program?.core_sync_state).toBe("synced");
  expect(program?.core_sync_error).toBeNull();
});

test("a program already synced is left alone — no redundant Core calls", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const calls: string[] = [];
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => true,
    syncProgramToCore: async (id: string) => {
      calls.push(id);
      return { ok: true };
    },
  }));

  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { updateHostedProgram } = await import("./hostedPrograms");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "recon-b", workspaceId: "T2", programName: "Recon B", ownerHcaId: "H2", ownerSlackId: "U2" });
  await claimHostedChannels({ workspaceId: "T2", programId: "recon-b", channels: [{ id: "C-help-b", kind: "help" }], claimedByHcaId: "H2" });
  await updateHostedProgram("recon-b", { core_sync_state: "synced", core_sync_error: null });

  const result = await reconcileHostedSync();
  expect(result.attempted).toBe(0);
  expect(calls).toEqual([]);
});

test("Core still down: program stays pending/failed, no throw, error recorded", async () => {
  mock.module("@/lib/db", () => createTestDb());
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => true,
    syncProgramToCore: async () => ({ ok: false, error: "core unreachable" }),
  }));

  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "recon-c", workspaceId: "T3", programName: "Recon C", ownerHcaId: "H3", ownerSlackId: "U3" });
  await claimHostedChannels({ workspaceId: "T3", programId: "recon-c", channels: [{ id: "C-help-c", kind: "help" }], claimedByHcaId: "H3" });

  const result = await reconcileHostedSync();
  expect(result.attempted).toBe(1);
  expect(result.synced).toBe(0);
  expect(result.stillFailed).toBe(1);
  expect(result.errors[0]).toEqual({ programId: "recon-c", error: "core unreachable" });

  const { getHostedProgram } = await import("./hostedPrograms");
  const program = await getHostedProgram("recon-c");
  expect(program?.core_sync_state).toBe("failed");
  expect(program?.core_sync_error).toBe("core unreachable");
});

test("re-running reconcile after Core recovers is idempotent — flips to synced, no duplicate side effects", async () => {
  mock.module("@/lib/db", () => createTestDb());
  let coreUp = false;
  const calls: string[] = [];
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => true,
    syncProgramToCore: async (id: string) => {
      calls.push(id);
      return coreUp ? { ok: true } : { ok: false, error: "core unreachable" };
    },
  }));

  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "recon-d", workspaceId: "T4", programName: "Recon D", ownerHcaId: "H4", ownerSlackId: "U4" });
  await claimHostedChannels({ workspaceId: "T4", programId: "recon-d", channels: [{ id: "C-help-d", kind: "help" }], claimedByHcaId: "H4" });

  const first = await reconcileHostedSync();
  expect(first.stillFailed).toBe(1);

  coreUp = true;
  const second = await reconcileHostedSync();
  expect(second.synced).toBe(1);
  expect(calls).toEqual(["recon-d", "recon-d"]);

  const { getHostedProgram } = await import("./hostedPrograms");
  const program = await getHostedProgram("recon-d");
  expect(program?.core_sync_state).toBe("synced");
});

test("skips the whole batch when Core is not configured at all", async () => {
  mock.module("@/lib/db", () => createTestDb());
  mock.module("@/lib/pixieCore", () => ({
    coreConfigured: () => false,
    syncProgramToCore: async () => {
      throw new Error("should not be called");
    },
  }));

  const { insertHostedProgram, claimHostedChannels } = await import("./programClaim");
  const { reconcileHostedSync } = await import("./hostedReconcile");

  await insertHostedProgram({ id: "recon-e", workspaceId: "T5", programName: "Recon E", ownerHcaId: "H5", ownerSlackId: "U5" });
  await claimHostedChannels({ workspaceId: "T5", programId: "recon-e", channels: [{ id: "C-help-e", kind: "help" }], claimedByHcaId: "H5" });

  const result = await reconcileHostedSync();
  expect(result.attempted).toBe(0);
});
