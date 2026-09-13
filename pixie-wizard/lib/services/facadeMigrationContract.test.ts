import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");

test("migration contract keeps legacy production modules authoritative", () => {
  const repository = readFileSync(join(root, "lib/repositories/hostedProgramRepository.ts"), "utf8");
  const access = readFileSync(join(root, "lib/services/programAccessService.ts"), "utf8");
  expect(repository).toContain('from "@/lib/hostedPrograms"');
  expect(repository).toContain('from "@/lib/programClaim"');
  expect(access).toContain('from "@/lib/programAccess"');
  expect(access).toContain("requireProgramMembership");
  expect(access).toContain("requireWizardSuperadmin");
});

test("reads go through hostedProgramRepository with direct parameterized SQL", () => {
  const repository = readFileSync(join(root, "lib/repositories/hostedProgramRepository.ts"), "utf8");
  const overview = readFileSync(join(root, "app/overview/page.tsx"), "utf8");
  const programs = readFileSync(join(root, "app/programs/page.tsx"), "utf8");

  // Direct SQL preserves exact row shapes, ordering, tenant predicates, and
  // the public-projection allowlist — no delegation for these five reads.
  expect(repository).toContain("lower(owner_hca_id) in (lower($1), lower($2))");
  expect(repository).toContain("order by created_at desc");
  expect(repository).toContain("core_sync_state <> 'synced'");
  expect(repository).toContain("order by updated_at asc");
  expect(repository).toContain("from hosted_program_channels where program_id = $1");
  expect(repository).toContain("from hosted_program_helpers where program_id = $1 and active = true");
  expect(repository).toContain("slack_user_id = $2 and active = true");

  // Directory pages read through the repository seam only; auth checks and
  // mutations stay on the legacy production modules.
  expect(overview).toContain("hostedProgramRepository");
  expect(overview).toContain("listHostedProgramsForOwner");
  expect(overview).not.toContain('from "@/lib/hostedPrograms"');
  expect(programs).toContain("hostedProgramRepository");
  expect(programs).toContain("listActiveHostedPrograms");
  expect(programs).not.toContain('from "@/lib/hostedPrograms"');
});
