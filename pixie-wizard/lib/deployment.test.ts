import { test, expect } from "bun:test";
import { isHostedMode, isDedicatedMode, sweeperScopeFor, activateHostedProgram } from "./deployment";

test("mode predicates split hosted from dedicated", () => {
  expect(isHostedMode("hosted_shared")).toBe(true);
  expect(isHostedMode("dedicated_legacy")).toBe(false);
  expect(isHostedMode(null)).toBe(false);
  expect(isDedicatedMode("dedicated_legacy")).toBe(true);
  expect(isDedicatedMode("hosted_shared")).toBe(false);
});

test("sweeper scope keeps hosted rows away from Railway deletion", () => {
  expect(sweeperScopeFor("hosted_shared")).toBe("hosted");
  expect(sweeperScopeFor("dedicated_legacy")).toBe("dedicated");
  expect(sweeperScopeFor(null)).toBe("dedicated");
  expect(sweeperScopeFor(undefined)).toBe("dedicated");
});

test("hosted activation performs no provisioning — it only creates config", async () => {
  let created = false;
  const res = await activateHostedProgram({
    createProgram: async () => {
      created = true;
      return { mode: "hosted_shared", programId: "hwy", workspaceId: "T1" };
    },
  });
  expect(created).toBe(true);
  expect(res.programId).toBe("hwy");
});
