import { test, expect, mock } from "bun:test";
import { createTestDb } from "./pgTestDb";
import type { WizardSession } from "./session";

function session(overrides: Partial<WizardSession> = {}): WizardSession {
  return { hcaId: "H_OTHER", email: "other@example.com", name: "Other", slackId: null, exp: 9999999999, ...overrides };
}

test("relationshipFor: public with no session at all", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["p1", "T1", "P1", "H_OWNER"]);
  const { getHostedProgram } = await import("./hostedPrograms");
  const program = await getHostedProgram("p1");
  expect(await relationshipFor(program!, null)).toBe("public");
});

test("relationshipFor: owner_hca_id match is 'owner', regardless of Slack membership", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  const { getHostedProgram } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["p2", "T1", "P2", "H_OWNER"]);
  const program = await getHostedProgram("p2");
  expect(await relationshipFor(program!, session({ hcaId: "H_OWNER" }))).toBe("owner");
});

test("relationshipFor: owner_hca_id may hold an email — a hand-transferred owner still resolves", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  const { getHostedProgram } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["p2e", "T1", "P2e", "New.Owner@Example.com"]);
  const program = await getHostedProgram("p2e");
  // Session's HCA id is the opaque ident! form; only the email matches the row.
  expect(await relationshipFor(program!, session({ hcaId: "ident!zzz", email: "new.owner@example.com" }))).toBe("owner");
  expect(await relationshipFor(program!, session({ hcaId: "ident!zzz", email: "someone.else@example.com" }))).toBe("public");
});

test("relationshipFor: an active helper row with role=organizer is 'admin'", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  const { getHostedProgram } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["p3", "T1", "P3", "H_OWNER"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ($1,$2,'organizer',true)`, ["p3", "U_ADMIN"]);
  const program = await getHostedProgram("p3");
  expect(await relationshipFor(program!, session({ hcaId: "H_OTHER", slackId: "U_ADMIN" }))).toBe("admin");
});

test("relationshipFor: an active helper row with role=helper is 'helper'", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  const { getHostedProgram } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["p4", "T1", "P4", "H_OWNER"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ($1,$2,'helper',true)`, ["p4", "U_HELPER"]);
  const program = await getHostedProgram("p4");
  expect(await relationshipFor(program!, session({ hcaId: "H_OTHER", slackId: "U_HELPER" }))).toBe("helper");
});

test("relationshipFor: a signed-in stranger with no owner/helper match is 'public' — not hidden, just non-member", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  const { getHostedProgram } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["p5", "T1", "P5", "H_OWNER"]);
  const program = await getHostedProgram("p5");
  expect(await relationshipFor(program!, session({ hcaId: "H_TOTALLY_UNRELATED", slackId: "U_RANDOM" }))).toBe("public");
});

test("relationshipFor: an inactive (removed) helper no longer counts as a member", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  const { getHostedProgram } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["p6", "T1", "P6", "H_OWNER"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ($1,$2,'helper',false)`, ["p6", "U_REMOVED"]);
  const program = await getHostedProgram("p6");
  expect(await relationshipFor(program!, session({ hcaId: "H_OTHER", slackId: "U_REMOVED" }))).toBe("public");
});

test("relationshipFor: a helper in one program is a stranger in another — role never crosses programs", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { relationshipFor } = await import("./programAccess");
  const { getHostedProgram } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["a", "T1", "A", "H_A"]);
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["b", "T1", "B", "H_B"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ($1,$2,'organizer',true)`, ["a", "U_X"]);
  const asAdminOfA = session({ hcaId: "H_OTHER", slackId: "U_X" });
  expect(await relationshipFor((await getHostedProgram("a"))!, asAdminOfA)).toBe("admin");
  expect(await relationshipFor((await getHostedProgram("b"))!, asAdminOfA)).toBe("public");
});

test("getHelperRow: returns only the active row for that exact program + slack user", async () => {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  const { getHelperRow } = await import("./hostedPrograms");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["g1", "T1", "G1", "H"]);
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["g2", "T1", "G2", "H"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ('g1','U_ACTIVE','helper',true)`);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ('g1','U_GONE','helper',false)`);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ('g2','U_ELSEWHERE','organizer',true)`);

  expect((await getHelperRow("g1", "U_ACTIVE"))?.role).toBe("helper");
  expect(await getHelperRow("g1", "U_GONE")).toBeNull();
  expect(await getHelperRow("g1", "U_ELSEWHERE")).toBeNull();
  expect(await getHelperRow("g2", "U_ACTIVE")).toBeNull();
});

test("loadProgramContext: resolves session + program + relationship, and denies an outsider", async () => {
  let currentSession: WizardSession | null = null;
  mock.module("@/lib/db", () => createTestDb());
  mock.module("@/lib/session", () => ({
    getSession: async () => currentSession,
  }));
  const { query } = await import("./db");
  const { loadProgramContext } = await import("./programAccess");
  await query(`insert into hosted_programs (id, workspace_id, program_name, owner_hca_id) values ($1,$2,$3,$4)`, ["ctx", "T1", "Ctx", "H_OWNER"]);
  await query(`insert into hosted_program_helpers (program_id, slack_user_id, role, active) values ('ctx','U_ORG','organizer',true)`);

  currentSession = session({ hcaId: "H_OWNER" });
  const asOwner = await loadProgramContext("ctx");
  expect(asOwner.program?.id).toBe("ctx");
  expect(asOwner.relationship).toBe("owner");

  currentSession = session({ hcaId: "H_STRANGER", slackId: "U_NOBODY" });
  expect((await loadProgramContext("ctx")).relationship).toBe("public");

  currentSession = session({ hcaId: "H_X", slackId: "U_ORG" });
  expect((await loadProgramContext("ctx")).relationship).toBe("admin");

  currentSession = null;
  const anon = await loadProgramContext("ctx");
  expect(anon.session).toBeNull();
  expect(anon.relationship).toBe("public");

  currentSession = session({ hcaId: "H_OWNER" });
  const missing = await loadProgramContext("does-not-exist");
  expect(missing.program).toBeNull();
  expect(missing.relationship).toBe("public");
});
