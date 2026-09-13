import { expect, mock, test } from "bun:test";
import { createTestDb } from "../pgTestDb";

test("hosted repository preserves public projection, helper roles, and tenant-scoped channel claims", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("../db");
  const { hostedProgramRepository: repository } = await import("./hostedProgramRepository");
  const { getHostedProgram: legacyGetHostedProgram } = await import("../hostedPrograms");

  await repository.insertHostedProgram({ id: "repo-a", workspaceId: "tenant-a", programName: "A", ownerHcaId: "H_A", ownerSlackId: null });
  await repository.insertHostedProgram({ id: "repo-b", workspaceId: "tenant-b", programName: "B", ownerHcaId: "H_B", ownerSlackId: null });
  await repository.claimHostedChannels({ workspaceId: "tenant-a", programId: "repo-a", channels: [{ id: "C_SHARED", kind: "help" }], claimedByHcaId: "H_A" });
  expect((await repository.claimHostedChannels({ workspaceId: "tenant-b", programId: "repo-b", channels: [{ id: "C_SHARED", kind: "help" }], claimedByHcaId: "H_B" })).ok).toBe(true);

  await repository.addHostedHelper({ programId: "repo-a", slackUserId: "U_HELPER", role: "organizer" });
  expect(await repository.getHostedProgram("repo-a")).toEqual(await legacyGetHostedProgram("repo-a"));
  expect((await repository.getHelperRow("repo-a", "U_HELPER"))?.role).toBe("organizer");
  expect(await repository.getPublicProgramProfile("repo-a")).toMatchObject({ id: "repo-a", programName: "A", roster: [{ role: "organizer" }] });

  const { rows } = await query<{ workspace_id: string; channel_id: string }>("select workspace_id, channel_id from hosted_program_channels order by workspace_id");
  expect(rows).toEqual([{ workspace_id: "tenant-a", channel_id: "C_SHARED" }, { workspace_id: "tenant-b", channel_id: "C_SHARED" }]);
});
