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
