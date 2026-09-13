import { expect, mock, test } from "bun:test";
import { createTestDb } from "../pgTestDb";

test("hosted repository preserves public projection, helper roles, and tenant-scoped channel claims", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("../db");
  const { hostedProgramRepository: repository } = await import("./hostedProgramRepository");
  const {
    getHostedProgram: legacyGetHostedProgram,
    listActiveHostedPrograms: legacyListActive,
    getPublicProgramProfile: legacyPublicProfile,
    listHostedProgramsForOwner: legacyOwnerList,
    listHostedChannels: legacyChannels,
    listHostedHelpers: legacyHelpers,
    getHelperRow: legacyHelperRow,
    listHostedProgramsPendingSync: legacyPendingSync,
  } = await import("../hostedPrograms");

  await repository.insertHostedProgram({ id: "repo-a", workspaceId: "tenant-a", programName: "A", ownerHcaId: "H_A", ownerSlackId: null });
  await repository.insertHostedProgram({ id: "repo-b", workspaceId: "tenant-b", programName: "B", ownerHcaId: "H_B", ownerSlackId: null });
  await repository.insertHostedProgram({ id: "repo-email", workspaceId: "tenant-a", programName: "E", ownerHcaId: "owner@example.com", ownerSlackId: null });
  await repository.claimHostedChannels({ workspaceId: "tenant-a", programId: "repo-a", channels: [{ id: "C_SHARED", kind: "help" }], claimedByHcaId: "H_A" });
  expect((await repository.claimHostedChannels({ workspaceId: "tenant-b", programId: "repo-b", channels: [{ id: "C_SHARED", kind: "help" }], claimedByHcaId: "H_B" })).ok).toBe(true);

  await repository.addHostedHelper({ programId: "repo-a", slackUserId: "U_HELPER", role: "organizer" });
  expect(await repository.getHostedProgram("repo-a")).toEqual(await legacyGetHostedProgram("repo-a"));
  expect(await repository.listActiveHostedPrograms()).toEqual(await legacyListActive());
  expect(await repository.getPublicProgramProfile("repo-a")).toEqual(await legacyPublicProfile("repo-a"));
  expect((await repository.getHelperRow("repo-a", "U_HELPER"))?.role).toBe("organizer");
  expect(await repository.getPublicProgramProfile("repo-a")).toMatchObject({ id: "repo-a", programName: "A", roster: [{ role: "organizer" }] });

  // Owner list parity — exact row shapes and created_at desc ordering, plus
  // the case-insensitive HCA-id-or-email identity form.
  expect(await repository.listHostedProgramsForOwner({ hcaId: "H_A", email: "a@example.com" })).toEqual(
    await legacyOwnerList({ hcaId: "H_A", email: "a@example.com" }),
  );
  expect(await repository.listHostedProgramsForOwner({ hcaId: "h_a", email: "H_A" })).toEqual(
    await legacyOwnerList({ hcaId: "h_a", email: "H_A" }),
  );
  expect(await repository.listHostedProgramsForOwner({ hcaId: "H_OTHER", email: "OWNER@example.com" })).toEqual(
    await legacyOwnerList({ hcaId: "H_OTHER", email: "OWNER@example.com" }),
  );
  expect((await repository.listHostedProgramsForOwner({ hcaId: "H_OTHER", email: "owner@example.com" })).map((r) => r.id)).toContain("repo-email");

  // Channels / helpers parity — exact row shapes and tenant predicates.
  expect(await repository.listHostedChannels("repo-a")).toEqual(await legacyChannels("repo-a"));
  expect(await repository.listHostedHelpers("repo-a")).toEqual(await legacyHelpers("repo-a"));
  expect(await repository.getHelperRow("repo-a", "U_HELPER")).toEqual(await legacyHelperRow("repo-a", "U_HELPER"));
  expect(await repository.getHelperRow("repo-a", "U_MISSING")).toEqual(await legacyHelperRow("repo-a", "U_MISSING"));

  // Pending-sync parity — anything not confirmed synced, oldest-first.
  expect(await repository.listHostedProgramsPendingSync()).toEqual(await legacyPendingSync());
  await query(`update hosted_programs set core_sync_state = 'synced', updated_at = now() where id = $1`, ["repo-b"]);
  expect(await repository.listHostedProgramsPendingSync()).toEqual(await legacyPendingSync());
  expect((await repository.listHostedProgramsPendingSync()).map((r) => r.id).sort()).toEqual(["repo-a", "repo-email"].sort());

  // Failed sync-state rows stay queued (the predicate must not narrow to pending only).
  await query(`update hosted_programs set core_sync_state = 'failed' where id = $1`, ["repo-a"]);
  expect((await repository.listHostedProgramsPendingSync()).map((r) => r.id)).toContain("repo-a");
  expect(await repository.listHostedProgramsPendingSync()).toEqual(await legacyPendingSync());

  // Null/malformed sources never crash the public profile.
  await query(`update hosted_programs set sources = '[null]' where id = 'repo-a'`);
  expect((await repository.getPublicProgramProfile("repo-a"))?.publicSourceCount).toBe(0);
  expect(await repository.getPublicProgramProfile("repo-a")).toEqual(await legacyPublicProfile("repo-a"));

  // Empty/disallowed patches are a no-op read, never a timestamp bump.
  const { updateHostedProgram } = await import("../hostedPrograms");
  const before = await repository.getHostedProgram("repo-a");
  expect(await updateHostedProgram("repo-a", {})).toEqual(before);


  // Suspended programs expose no helper identity keys.
  await repository.insertHostedProgram({ id: "repo-suspended", workspaceId: "tenant-a", programName: "S", ownerHcaId: "H_A", ownerSlackId: null });
  await repository.addHostedHelper({ programId: "repo-suspended", slackUserId: "U_SUSP", role: "helper" });
  const { listVisibleHelperIdentityKeys, logHostedAudit, listHostedAudit } = await import("../hostedPrograms");
  await updateHostedProgram("repo-suspended", { status: "suspended" });
  expect(await listVisibleHelperIdentityKeys("repo-suspended")).toEqual([]);
  expect(await repository.getPublicProgramProfile("repo-suspended")).toBeNull();

  // Audit listing clamps extreme limits instead of scanning unbounded.
  await logHostedAudit({ programId: "repo-a", actorHcaId: "H_A", action: "audit.clamp" });
  expect((await listHostedAudit("repo-a", 10_000)).length).toBeGreaterThanOrEqual(1);

  const { rows } = await query<{ workspace_id: string; channel_id: string }>("select workspace_id, channel_id from hosted_program_channels order by workspace_id");
  expect(rows).toEqual([{ workspace_id: "tenant-a", channel_id: "C_SHARED" }, { workspace_id: "tenant-b", channel_id: "C_SHARED" }]);
});
