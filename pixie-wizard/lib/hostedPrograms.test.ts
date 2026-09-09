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

test("updateHostedProgram persists reply_signature, incident_mode and public_tickets_enabled — the drift-prone columns", async () => {
  // Guards the schema drift fix: db/schema.sql must carry a standalone
  // `alter table ... add column if not exists reply_signature` (create-table
  // is a no-op on deployed databases), and the column must be in the
  // updateHostedProgram allowlist, or a settings save 500s in production.
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { updateHostedProgram, getHostedProgram } = await import("./hostedPrograms");

  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["sig-a", "T1", "Sig A", "H1"]);

  const fresh = await getHostedProgram("sig-a");
  expect(fresh?.reply_signature).toBeNull();
  expect(fresh?.incident_mode).toBe("ANSWER_AND_TRACK");
  expect(fresh?.public_tickets_enabled).toBe(true);

  const updated = await updateHostedProgram("sig-a", {
    reply_signature: "stay wired :hardwire:",
    incident_mode: "ANSWER_ONLY",
    public_tickets_enabled: false,
  });
  expect(updated.reply_signature).toBe("stay wired :hardwire:");
  expect(updated.incident_mode).toBe("ANSWER_ONLY");
  expect(updated.public_tickets_enabled).toBe(false);

  const cleared = await updateHostedProgram("sig-a", { reply_signature: null });
  expect(cleared.reply_signature).toBeNull();
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

test("setHelperVisibility flips visible_on_profile on and off without touching role/active", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { setHelperVisibility } = await import("./hostedPrograms");

  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["vis-a", "T1", "Vis A", "H1"]);
  await query(
    `insert into hosted_program_helpers (program_id, slack_user_id, role, active, visible_on_profile) values ($1,$2,'helper',true,true)`,
    ["vis-a", "U_TOGGLE"],
  );

  const hidden = await setHelperVisibility("vis-a", "U_TOGGLE", false);
  expect(hidden.visible_on_profile).toBe(false);
  expect(hidden.role).toBe("helper");
  expect(hidden.active).toBe(true); // real permission untouched by the display toggle

  const shown = await setHelperVisibility("vis-a", "U_TOGGLE", true);
  expect(shown.visible_on_profile).toBe(true);
  expect(shown.active).toBe(true);
});

test("wizard people and global access are program-scoped and idempotent", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { upsertWizardPerson, addHostedHelper, listProgramAccessForPerson, setWizardSuperadmin, isWizardSuperadmin } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ('people-a','T1','A','H1'),('people-b','T1','B','H2')`);
  await upsertWizardPerson({ hcaId: "H_PERSON", email: "person@example.com", displayName: "Person", slackUserId: "U_PERSON" });
  await addHostedHelper({ programId: "people-a", slackUserId: "U_PERSON", role: "helper" });
  await addHostedHelper({ programId: "people-b", slackUserId: "U_PERSON", role: "organizer" });
  const access = await listProgramAccessForPerson("H_PERSON");
  expect(access.map((p) => [p.id, p.role])).toEqual([["people-a", "helper"], ["people-b", "organizer"]]);
  await setWizardSuperadmin("H_PERSON", "H_ROOT", true);
  expect(await isWizardSuperadmin("H_PERSON")).toBe(true);
});

test("superadmin bootstrap allowlist is explicit and persisted revoke is possible", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { upsertWizardPerson, setWizardSuperadmin, revokeWizardSuperadmin, isWizardSuperadmin, isBootstrapSuperadmin } = await import("./hostedPrograms");
  await upsertWizardPerson({ hcaId: "H_ROOT", email: "ROOT@EXAMPLE.COM", displayName: "Root" });
  await upsertWizardPerson({ hcaId: "H_OTHER", email: "other@example.com", displayName: "Other" });
  await setWizardSuperadmin("H_ROOT", "H_ROOT", true);
  await setWizardSuperadmin("H_OTHER", "H_ROOT", true);
  expect(await isWizardSuperadmin("H_ROOT")).toBe(true);
  await revokeWizardSuperadmin("H_ROOT", "H_OTHER");
  expect(await isWizardSuperadmin("H_ROOT")).toBe(false);
  await expect(revokeWizardSuperadmin("H_OTHER", "H_OTHER")).rejects.toThrow(/final effective/);
  process.env.PIXIE_WIZARD_SUPERADMIN_ALLOWLIST = "H_BOOT";
  expect(isBootstrapSuperadmin("H_BOOT")).toBe(true);
  await expect(revokeWizardSuperadmin("H_BOOT", "H_ROOT")).rejects.toThrow(/deployment configuration/);
  delete process.env.PIXIE_WIZARD_SUPERADMIN_ALLOWLIST;
  await query(`select 1`);
});

test("a helper hidden from the public profile still appears in the real (non-public) helper list — permissions preserved", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { setHelperVisibility, listHostedHelpers, getPublicProgramProfile } = await import("./hostedPrograms");

  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["vis-b", "T1", "Vis B", "H1"]);
  await query(
    `insert into hosted_program_helpers (program_id, slack_user_id, role, active, visible_on_profile) values ($1,$2,'organizer',true,true)`,
    ["vis-b", "U_HIDE_ME"],
  );

  await setHelperVisibility("vis-b", "U_HIDE_ME", false);

  // Gone from the public roster...
  const profile = await getPublicProgramProfile("vis-b");
  expect(profile?.roster).toEqual([]);

  // ...but still fully present, active, with the same role, in the real list.
  const real = await listHostedHelpers("vis-b");
  expect(real).toHaveLength(1);
  expect(real[0].active).toBe(true);
  expect(real[0].role).toBe("organizer");
});

test("setHelperVisibility is program-scoped — cannot touch another program's row for the same slack_user_id", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { setHelperVisibility } = await import("./hostedPrograms");

  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["vis-c1", "T1", "Vis C1", "H1"]);
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["vis-c2", "T1", "Vis C2", "H1"]);
  // Same slack_user_id helps both programs.
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active, visible_on_profile) values ($1,$2,'helper',true,true)`, ["vis-c1", "U_SHARED"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active, visible_on_profile) values ($1,$2,'helper',true,true)`, ["vis-c2", "U_SHARED"]);

  await setHelperVisibility("vis-c1", "U_SHARED", false);

  const { rows } = await query<{ program_id: string; visible_on_profile: boolean }>(
    `select program_id, visible_on_profile from hosted_program_helpers where slack_user_id = $1 order by program_id`,
    ["U_SHARED"],
  );
  expect(rows).toEqual([
    { program_id: "vis-c1", visible_on_profile: false },
    { program_id: "vis-c2", visible_on_profile: true },
  ]);
});

test("setHelperVisibility throws for a helper that doesn't exist on this program", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { setHelperVisibility } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["vis-d", "T1", "Vis D", "H1"]);
  await expect(setHelperVisibility("vis-d", "U_NEVER_ADDED", false)).rejects.toThrow(/not found/);
});
