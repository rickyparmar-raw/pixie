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
