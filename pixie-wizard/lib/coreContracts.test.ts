import { expect, test } from "bun:test";
import { validateCoreProgramSyncPatch } from "./coreContracts";

test("accepts full and partial Core program sync payloads", () => {
  expect(validateCoreProgramSyncPatch("program-a", {
    name: "Program A",
    workspaceId: "workspace-a",
    posture: "active",
    scope: "program",
    aiAnswers: true,
    ticketsEnabled: true,
    incidentMode: "ANSWER_AND_TRACK",
    sources: [{ name: "Docs", type: "url", url: "https://example.com/docs" }],
    programChannels: [{ id: "C-HELP", kind: "help" }],
  }).ok).toBe(true);
  expect(validateCoreProgramSyncPatch("program-a", { sources: [] }).ok).toBe(true);
  expect(validateCoreProgramSyncPatch("program-a", { helpChannel: "C-HELP" }).ok).toBe(true);
});

test("rejects malformed sync fields without exposing payload values", () => {
  const result = validateCoreProgramSyncPatch("program-a", { incidentMode: "invented", apiKey: "secret-value" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.field).toBe("incidentMode");
    expect(result.error.message).not.toContain("secret-value");
  }
  expect(validateCoreProgramSyncPatch("", {}).ok).toBe(false);
});

test("preserves unknown forward-compatible fields after known validation", () => {
  const result = validateCoreProgramSyncPatch("program-a", { futureFlag: "preserve" });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.futureFlag).toBe("preserve");
});
