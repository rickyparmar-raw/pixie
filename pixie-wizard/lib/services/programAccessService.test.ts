import { expect, mock, test } from "bun:test";
import type { WizardSession } from "../session";

const session: WizardSession = { hcaId: "H_OWNER", email: "owner@example.com", name: "Owner", slackId: null, exp: 9999999999 };

test("access service is a parity seam over the authoritative access façade", async () => {
  mock.module("@/lib/programAccess", () => ({
    relationshipFor: async () => "owner",
    loadProgramContext: async () => ({ session, program: null, relationship: "public" }),
    linkedSlackSession: async () => null,
    requireProgramMembership: async () => { throw new Error("redirect boundary"); },
    isSuperadminSession: async () => true,
    ownProgramPath: async () => "/wizard",
    requireWizardSuperadmin: async () => session,
  }));
  const { programAccessService } = await import("./programAccessService");

  expect(await programAccessService.relationshipFor({} as never, session)).toBe("owner");
  expect(await programAccessService.isSuperadminSession({ hcaId: "H", email: "h@example.com" })).toBe(true);
  await expect(programAccessService.requireProgramMembership("missing")).rejects.toThrow("redirect boundary");
  expect(await programAccessService.requireWizardSuperadmin()).toBe(session);
});

test("program layout uses the repository-backed context loader", async () => {
  const source = await Bun.file(new URL("../../app/programs/[id]/layout.tsx", import.meta.url)).text();
  expect(source).toContain("loadProgramContextFromRepository");
  expect(source).not.toContain("loadProgramContext(id)");
});
