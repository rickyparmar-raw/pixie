import { test, expect, afterEach } from "bun:test";
import { programSlugFor, creatorEligible } from "./programClaim";
import { isLocalDemoEnabled, isLoopbackHost } from "./session";

const savedCreatorAllowlist = process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST;
afterEach(() => {
  if (savedCreatorAllowlist === undefined) delete process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST;
  else process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST = savedCreatorAllowlist;
});

test("programSlugFor derives a safe slug or rejects", () => {
  expect(programSlugFor("Highway")).toBe("highway");
  expect(programSlugFor("Solvable!")).toBe("solvable");
  expect(() => programSlugFor("x")).toThrow();
  expect(() => programSlugFor("has space and $ymbols ok")).not.toThrow();
});

test("demo login is limited to loopback development URLs", () => {
  expect(isLocalDemoEnabled("development", "http://localhost:4901", "1")).toBe(true);
  expect(isLocalDemoEnabled("development", "http://127.0.0.1:4901", "1")).toBe(true);
  expect(isLocalDemoEnabled("development", "http://[::1]:4901", "1")).toBe(true);
  expect(isLocalDemoEnabled("development", "https://pixie.example.com")).toBe(false);
  expect(isLocalDemoEnabled("development", "http://localhost:4901", "0")).toBe(false);
  expect(isLocalDemoEnabled("development", "http://localhost:4901")).toBe(false);
  expect(isLocalDemoEnabled("production", "http://localhost:4901", "1")).toBe(false);
  expect(isLocalDemoEnabled("production", "http://localhost:4901", "0")).toBe(false);
  expect(isLocalDemoEnabled("production", "https://pixie.example.com", "1")).toBe(false);
  expect(isLoopbackHost("localhost:4901")).toBe(true);
  expect(isLoopbackHost("127.0.0.1:4901")).toBe(true);
  expect(isLoopbackHost("attacker.example:443")).toBe(false);
  expect(isLocalDemoEnabled("development", "not-a-url")).toBe(false);
});

test("program creation is invite-only: unset creator allowlist denies everyone", () => {
  delete process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST;
  const session = { hcaId: "U1", email: "a@example.com", name: "A", slackId: null, exp: 9999999999 };
  expect(creatorEligible(session)).toBe(false);

  process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST = "owner@example.com";
  expect(creatorEligible(session)).toBe(false);
  expect(creatorEligible({ ...session, email: "owner@example.com" })).toBe(true);
  expect(creatorEligible({ ...session, hcaId: "owner@example.com" })).toBe(true);
});

import { mock } from "bun:test";
import { createTestDb } from "./pgTestDb";
import { insertHostedProgram, claimHostedChannels } from "./programClaim";

mock.module("@/lib/db", () => createTestDb());

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

/* -------------------------------------------------------------------------- */
/* Concurrency: the pre-check alone is not the guarantee — a real unique      */
/* constraint at the DB layer is. These prove the constraint exists and that  */
/* the application code correctly surfaces a genuine race rather than        */
/* silently reporting {ok: true} for a channel it lost.                      */
/* -------------------------------------------------------------------------- */

test("the database itself rejects a duplicate (workspace_id, channel_id) row — not just the application pre-check", async () => {
  const { query } = await import("./db");
  const { insertHostedProgram: insert } = await import("./programClaim");
  await insert({ id: "race-a", workspaceId: "T_RACE", programName: "Race A", ownerHcaId: "H1", ownerSlackId: null });
  await insert({ id: "race-b", workspaceId: "T_RACE", programName: "Race B", ownerHcaId: "H2", ownerSlackId: null });

  // Bypass claimHostedChannels' own guard entirely — insert directly, the way
  // a second concurrent transaction would land after this one already
  // committed. If this only worked because of the application-level
  // pre-check, it would succeed here too. It must not.
  await query(
    `insert into hosted_program_channels (workspace_id, channel_id, program_id, kind) values ($1, $2, $3, 'help')`,
    ["T_RACE", "C-race", "race-a"],
  );
  await expect(
    query(
      `insert into hosted_program_channels (workspace_id, channel_id, program_id, kind) values ($1, $2, $3, 'help')`,
      ["T_RACE", "C-race", "race-b"],
    ),
  ).rejects.toMatchObject({ code: "23505" });
});

test("two truly concurrent claimHostedChannels calls for the same channel: exactly one wins, the loser reports the real owner", async () => {
  const { insertHostedProgram: insert, claimHostedChannels: claim } = await import("./programClaim");
  await insert({ id: "race-c", workspaceId: "T_RACE2", programName: "Race C", ownerHcaId: "H1", ownerSlackId: null });
  await insert({ id: "race-d", workspaceId: "T_RACE2", programName: "Race D", ownerHcaId: "H2", ownerSlackId: null });

  // Fired together (no await between them) so both start their pre-check
  // pass before either has inserted anything — the scenario the pre-check
  // alone cannot resolve, and only the database's own constraint can.
  const [resC, resD] = await Promise.all([
    claim({ workspaceId: "T_RACE2", programId: "race-c", channels: [{ id: "C-race2", kind: "help" }], claimedByHcaId: "H1" }),
    claim({ workspaceId: "T_RACE2", programId: "race-d", channels: [{ id: "C-race2", kind: "help" }], claimedByHcaId: "H2" }),
  ]);

  const results = [resC, resD];
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok) as Array<{ ok: false; conflictChannel: string; ownerProgramId: string | null }>;

  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0].conflictChannel).toBe("C-race2");
  // The loser must report whoever actually holds the channel now — not null,
  // not itself, and not a stale pre-check snapshot.
  const { query } = await import("./db");
  const { rows } = await query<{ program_id: string }>(
    `select program_id from hosted_program_channels where workspace_id = $1 and channel_id = $2`,
    ["T_RACE2", "C-race2"],
  );
  expect(rows).toHaveLength(1);
  expect(losers[0].ownerProgramId).toBe(rows[0].program_id);
});

