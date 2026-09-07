import { test, expect, afterEach } from "bun:test";
import { programSlugFor, creatorEligible } from "./programClaim";

const savedAllowlist = process.env.PIXIE_WIZARD_ALLOWLIST;
afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.PIXIE_WIZARD_ALLOWLIST;
  else process.env.PIXIE_WIZARD_ALLOWLIST = savedAllowlist;
});

test("programSlugFor derives a safe slug or rejects", () => {
  expect(programSlugFor("Highway")).toBe("highway");
  expect(programSlugFor("Solvable!")).toBe("solvable");
  expect(() => programSlugFor("x")).toThrow();
  expect(() => programSlugFor("has space and $ymbols ok")).not.toThrow();
});

test("creator eligibility follows the allowlist, defaulting open", () => {
  delete process.env.PIXIE_WIZARD_ALLOWLIST;
  const session = { hcaId: "U1", email: "a@example.com", name: "A", slackId: null, exp: 9999999999 };
  expect(creatorEligible(session)).toBe(true);

  process.env.PIXIE_WIZARD_ALLOWLIST = "owner@example.com";
  expect(creatorEligible(session)).toBe(false);
  expect(creatorEligible({ ...session, email: "owner@example.com" })).toBe(true);
});

import { mock } from "bun:test";
import { createSupabaseFake } from "./supabaseFake";
import { insertHostedProgram, claimHostedChannels } from "./programClaim";

// Same shared factory as sweepTrials.test.ts: identical shape, no clobbering.
mock.module("@/lib/supabase", () => createSupabaseFake());

test("insertHostedProgram rejects a live duplicate slug (double-submit collapses)", async () => {
  await insertHostedProgram({ id: "hwy", workspaceId: "T1", programName: "Highway", ownerHcaId: "H1", ownerSlackId: "U1" });
  await expect(
    insertHostedProgram({ id: "hwy", workspaceId: "T1", programName: "Highway Again", ownerHcaId: "H1", ownerSlackId: "U1" }),
  ).rejects.toThrow(/already active/);
});

test("channel claims succeed atomically and roll back on conflict", async () => {
  // Another program owns C-taken.
  const { insertHostedProgram: insert, claimHostedChannels: claim } = await import("./programClaim");
  await insert({ id: "other", workspaceId: "T9", programName: "Other", ownerHcaId: "H9", ownerSlackId: null });
  await claim({ workspaceId: "T9", programId: "other", channels: [{ id: "C-taken", kind: "help" }], claimedByHcaId: "H9" });

  await insert({ id: "newprog", workspaceId: "T9", programName: "New", ownerHcaId: "H1", ownerSlackId: null });
  const res = await claim({
    workspaceId: "T9",
    programId: "newprog",
    channels: [
      { id: "C-free", kind: "help" },
      { id: "C-taken", kind: "discussion" },
    ],
    claimedByHcaId: "H1",
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.conflictChannel).toBe("C-taken");
    expect(res.ownerProgramId).toBe("other");
  }
});

test("re-claiming your own channels is idempotent", async () => {
  const { claimHostedChannels: claim } = await import("./programClaim");
  const first = await claim({ workspaceId: "T9", programId: "newprog", channels: [{ id: "C-mine", kind: "help" }], claimedByHcaId: "H1" });
  expect(first.ok).toBe(true);
  const second = await claim({ workspaceId: "T9", programId: "newprog", channels: [{ id: "C-mine", kind: "help" }], claimedByHcaId: "H1" });
  expect(second.ok).toBe(true);
});

test("validateOrDeriveSlug handles derived and custom slugs", async () => {
  const { validateOrDeriveSlug: valSlug } = await import("./programClaim");
  expect(valSlug("My Cool Program")).toBe("my-cool-program");
  expect(valSlug("My Program", "custom-slug")).toBe("custom-slug");
  expect(() => valSlug("My Program", "INVALID")).toThrow();
  expect(() => valSlug("My Program", "x")).toThrow();
});

test("findChannelConflicts discovers taken channels before claim", async () => {
  const { insertHostedProgram: insert, claimHostedChannels: claim, findChannelConflicts: conflicts } = await import("./programClaim");
  await insert({ id: "owner-prog", workspaceId: "T_TEST", programName: "Owner Prog", ownerHcaId: "H_OWNER", ownerSlackId: null });
  await claim({ workspaceId: "T_TEST", programId: "owner-prog", channels: [{ id: "C-claimed", kind: "help" }], claimedByHcaId: "H_OWNER" });

  const conflict = await conflicts("T_TEST", "different-prog", ["C-free", "C-claimed"]);
  expect(conflict).not.toBeNull();
  expect(conflict?.conflictChannel).toBe("C-claimed");
  expect(conflict?.ownerProgramId).toBe("owner-prog");

  const noConflict = await conflicts("T_TEST", "owner-prog", ["C-claimed"]);
  expect(noConflict).toBeNull();
});

