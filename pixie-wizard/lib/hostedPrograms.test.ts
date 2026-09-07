import { test, expect, mock } from "bun:test";
import { createTestDb } from "./pgTestDb";

test("getPublicProgramProfile returns only the allowlisted fields — no owner/settings/sync-error leakage", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getPublicProgramProfile } = await import("./hostedPrograms");

  await query(
    `insert into hosted_programs (id, workspace_id, program_name, program_description, owner_hca_id, owner_slack_id, support_name, status, core_sync_error, settings, sources)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      "pub-a",
      "T1",
      "Public A",
      "a public description",
      "H_SECRET_OWNER",
      "U_SECRET_OWNER",
      "Support A",
      "active",
      "leaked internal error detail",
      JSON.stringify({ internalFlag: true }),
      JSON.stringify([{ type: "url", url: "https://private.example.com", public: false }]),
    ],
  );

  const profile = await getPublicProgramProfile("pub-a");
  expect(profile).not.toBeNull();
  expect(profile?.programName).toBe("Public A");
  expect(profile?.description).toBe("a public description");
  expect(profile?.supportName).toBe("Support A");
  expect(profile?.publicSourceCount).toBe(0); // source had public: false

  // Nothing beyond the declared PublicProgramProfile shape should exist —
  // this is the check that actually catches a future accidental leak.
  const allowedKeys = new Set([
    "id", "programName", "description", "supportName", "iconUrl", "status",
    "publicHelpChannelId", "publicSourceCount", "roster",
  ]);
  for (const key of Object.keys(profile as object)) {
    expect(allowedKeys.has(key), `unexpected key on public profile: ${key}`).toBe(true);
  }
  // Explicitly confirm the sensitive fields are nowhere in the object at all.
  const serialized = JSON.stringify(profile);
  expect(serialized).not.toContain("H_SECRET_OWNER");
  expect(serialized).not.toContain("U_SECRET_OWNER");
  expect(serialized).not.toContain("leaked internal error detail");
  expect(serialized).not.toContain("internalFlag");
  expect(serialized).not.toContain("private.example.com");
});

test("getPublicProgramProfile counts only sources explicitly marked public", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getPublicProgramProfile } = await import("./hostedPrograms");

  await query(
    `insert into hosted_programs (id, workspace_id, program_name, owner_hca_id, sources)
     values ($1, $2, $3, $4, $5)`,
    [
      "pub-b",
      "T1",
      "Public B",
      "H1",
      JSON.stringify([
        { type: "url", url: "https://a.example.com", public: true },
        { type: "url", url: "https://b.example.com" }, // no `public` field at all
        { type: "url", url: "https://c.example.com", public: false },
      ]),
    ],
  );

  const profile = await getPublicProgramProfile("pub-b");
  expect(profile?.publicSourceCount).toBe(1);
});

test("getPublicProgramProfile only lists helpers with visible_on_profile = true, and never the underlying slack_user_id", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getPublicProgramProfile } = await import("./hostedPrograms");

  await query(
    `insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1, $2, $3, $4)`,
    ["pub-c", "T1", "Public C", "H1"],
  );
  await query(
    `insert into hosted_program_helpers (program_id, slack_user_id, role, visible_on_profile) values
     ($1, 'U_VISIBLE_1', 'helper', true),
     ($1, 'U_HIDDEN_SECRET', 'organizer', false)`,
    ["pub-c"],
  );

  const profile = await getPublicProgramProfile("pub-c");
  expect(profile?.roster).toEqual([{ role: "helper" }]);
  const serialized = JSON.stringify(profile);
  expect(serialized).not.toContain("U_VISIBLE_1");
  expect(serialized).not.toContain("U_HIDDEN_SECRET");
});

test("getPublicProgramProfile returns null for a suspended/archived program", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getPublicProgramProfile } = await import("./hostedPrograms");

  await query(
    `insert into hosted_programs (id, workspace_id, program_name, owner_hca_id, status) values ($1, $2, $3, $4, $5)`,
    ["pub-d", "T1", "Public D", "H1", "suspended"],
  );

  expect(await getPublicProgramProfile("pub-d")).toBeNull();
});

test("listActiveHostedPrograms only returns active programs, ordered by name", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { listActiveHostedPrograms } = await import("./hostedPrograms");

  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id, status) values ($1,$2,$3,$4,$5)`, ["z-active", "T1", "Zed Active", "H1", "active"]);
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id, status) values ($1,$2,$3,$4,$5)`, ["a-active", "T1", "Alpha Active", "H1", "active"]);
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id, status) values ($1,$2,$3,$4,$5)`, ["b-suspended", "T1", "Beta Suspended", "H1", "suspended"]);

  const rows = await listActiveHostedPrograms();
  expect(rows.map((r) => r.id)).toEqual(["a-active", "z-active"]);
});
