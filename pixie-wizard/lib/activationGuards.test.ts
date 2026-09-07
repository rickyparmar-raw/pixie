import { test, expect } from "bun:test";
import { mock } from "bun:test";
import { createTestDb } from "./pgTestDb";
import { validateActivationGuards, isValidSlackChannelId } from "./activationGuards";
import { insertHostedProgram, claimHostedChannels } from "./programClaim";

mock.module("@/lib/db", () => createTestDb());

const validSources = [{ type: "url" as const, url: "https://docs.example.com/api" }];

const baseValidInput = {
  workspaceId: "T_CENTRAL",
  expectedWorkspaceId: "T_CENTRAL",
  programName: "Highway Project",
  helpChannelId: "C0123456789",
  organizerChannelId: "G0987654321",
  sources: validSources,
  checkDbConflicts: true,
  membershipChecker: async (ch: string) => ({
    ok: true,
    hasAccess: true,
    name: ch,
    isPrivate: ch.startsWith("G"),
    isArchived: false,
  }),
};

test("isValidSlackChannelId accurately screens Slack channel IDs", () => {
  expect(isValidSlackChannelId("C0123456789")).toBe(true);
  expect(isValidSlackChannelId("G0123456789")).toBe(true);
  expect(isValidSlackChannelId("c0123456789")).toBe(false);
  expect(isValidSlackChannelId("random-name")).toBe(false);
  expect(isValidSlackChannelId("")).toBe(false);
});

test("happy path passes all hard activation guards", async () => {
  const res = await validateActivationGuards(baseValidInput);
  expect(res.ok).toBe(true);
  expect(res.error).toBeUndefined();
  expect(res.validatedSlug).toBe("highway-project");
  expect(res.channels).toHaveLength(2);
  expect(res.channels![0]).toEqual({ id: "C0123456789", kind: "help" });
  expect(res.channels![1]).toEqual({ id: "G0987654321", kind: "organizer" });
});

test("guard: help channel is required", async () => {
  const res = await validateActivationGuards({
    ...baseValidInput,
    helpChannelId: "",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/help channel is required/i);
});

test("guard: organizer channel is required", async () => {
  const res = await validateActivationGuards({
    ...baseValidInput,
    organizerChannelId: "",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/organizer channel is required/i);
});

test("guard: invalid channel ID format is rejected", async () => {
  const res1 = await validateActivationGuards({
    ...baseValidInput,
    helpChannelId: "invalid_id",
  });
  expect(res1.ok).toBe(false);
  expect(res1.error).toMatch(/invalid help channel id format/i);

  const res2 = await validateActivationGuards({
    ...baseValidInput,
    organizerChannelId: "invalid_id",
  });
  expect(res2.ok).toBe(false);
  expect(res2.error).toMatch(/invalid organizer channel id format/i);
});

test("HARD GUARD: help != organizer (they MUST be different channels!)", async () => {
  const sameChannel = "C0123456789";
  const res = await validateActivationGuards({
    ...baseValidInput,
    helpChannelId: sameChannel,
    organizerChannelId: sameChannel,
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/help channel and organizer channel must be different channels/i);
});

test("guard: extra channels must not duplicate help or organizer channel", async () => {
  const dupHelp = await validateActivationGuards({
    ...baseValidInput,
    extraChannelIds: ["C0123456789"],
  });
  expect(dupHelp.ok).toBe(false);
  expect(dupHelp.error).toMatch(/duplicates the help channel/i);

  const dupOrg = await validateActivationGuards({
    ...baseValidInput,
    extraChannelIds: ["G0987654321"],
  });
  expect(dupOrg.ok).toBe(false);
  expect(dupOrg.error).toMatch(/duplicates the organizer channel/i);

  const dupSelf = await validateActivationGuards({
    ...baseValidInput,
    extraChannelIds: ["C1111111111", "C1111111111"],
  });
  expect(dupSelf.ok).toBe(false);
  expect(dupSelf.error).toMatch(/duplicate extra channel/i);
});

test("guard: Pixie is member of both channels", async () => {
  // Pixie not in help channel
  const noHelpAccess = await validateActivationGuards({
    ...baseValidInput,
    membershipChecker: async (ch: string) => ({
      ok: true,
      hasAccess: ch !== "C0123456789",
      name: ch,
      isPrivate: ch.startsWith("G"),
    }),
  });
  expect(noHelpAccess.ok).toBe(false);
  expect(noHelpAccess.error).toMatch(/pixie is not a member of the help channel/i);
  expect(noHelpAccess.error).toMatch(/\/invite @Pixie/);

  // Pixie not in organizer channel
  const noOrgAccess = await validateActivationGuards({
    ...baseValidInput,
    membershipChecker: async (ch: string) => ({
      ok: true,
      hasAccess: ch !== "G0987654321",
      name: ch,
      isPrivate: ch.startsWith("G"),
    }),
  });
  expect(noOrgAccess.ok).toBe(false);
  expect(noOrgAccess.error).toMatch(/pixie is not a member of the organizer channel/i);
  expect(noOrgAccess.error).toMatch(/\/invite @Pixie/);
});

test("guard: archived channels are rejected", async () => {
  const archivedHelp = await validateActivationGuards({
    ...baseValidInput,
    membershipChecker: async (ch: string) => ({
      ok: true,
      hasAccess: true,
      name: ch,
      isPrivate: ch.startsWith("G"),
      isArchived: ch === "C0123456789",
    }),
  });
  expect(archivedHelp.ok).toBe(false);
  expect(archivedHelp.error).toMatch(/help channel .* is archived/i);

  const archivedOrg = await validateActivationGuards({
    ...baseValidInput,
    membershipChecker: async (ch: string) => ({
      ok: true,
      hasAccess: true,
      name: ch,
      isPrivate: ch.startsWith("G"),
      isArchived: ch === "G0987654321",
    }),
  });
  expect(archivedOrg.ok).toBe(false);
  expect(archivedOrg.error).toMatch(/organizer channel .* is archived/i);
});

test("HARD GUARD: organizer channel must be private where required", async () => {
  // Public organizer channel without override must be rejected
  const publicOrgRes = await validateActivationGuards({
    ...baseValidInput,
    organizerChannelId: "C9999999999", // C prefix typically public
    membershipChecker: async () => ({
      ok: true,
      hasAccess: true,
      isPrivate: false,
      isArchived: false,
    }),
  });
  expect(publicOrgRes.ok).toBe(false);
  expect(publicOrgRes.error).toMatch(/organizer channel .* must be a private channel/i);

  // When explicit override is enabled, public organizer is permitted
  const allowedPublic = await validateActivationGuards({
    ...baseValidInput,
    organizerChannelId: "C9999999999",
    allowPublicOrganizer: true,
    membershipChecker: async () => ({
      ok: true,
      hasAccess: true,
      isPrivate: false,
      isArchived: false,
    }),
  });
  expect(allowedPublic.ok).toBe(true);
});

test("guard: workspace matches", async () => {
  const res = await validateActivationGuards({
    ...baseValidInput,
    workspaceId: "T_WRONG_WORKSPACE",
    expectedWorkspaceId: "T_CENTRAL",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/workspace mismatch/i);
});

test("guard: usable knowledge exists (at least one valid source required)", async () => {
  const noSources = await validateActivationGuards({
    ...baseValidInput,
    sources: [],
  });
  expect(noSources.ok).toBe(false);
  expect(noSources.error).toMatch(/at least one usable knowledge source is required/i);

  const invalidType = await validateActivationGuards({
    ...baseValidInput,
    // @ts-expect-error test invalid type
    sources: [{ type: "unknown-type", url: "https://example.com" }],
  });
  expect(invalidType.ok).toBe(false);
  expect(invalidType.error).toMatch(/unknown type/i);

  const missingUrl = await validateActivationGuards({
    ...baseValidInput,
    sources: [{ type: "url", url: "" }],
  });
  expect(missingUrl.ok).toBe(false);
  expect(missingUrl.error).toMatch(/missing its url/i);

  const ssrfUrl = await validateActivationGuards({
    ...baseValidInput,
    sources: [{ type: "url", url: "http://127.0.0.1:8000/internal" }],
  });
  expect(ssrfUrl.ok).toBe(false);
  expect(ssrfUrl.error).toMatch(/url rejected/i);

  const privateIpUrl = await validateActivationGuards({
    ...baseValidInput,
    sources: [{ type: "url", url: "https://192.168.1.5/docs" }],
  });
  expect(privateIpUrl.ok).toBe(false);
  expect(privateIpUrl.error).toMatch(/url rejected/i);
});

test("guard: cross-program channel reuse rejection (help & organizer)", async () => {
  const existingProgId = "existing-prog";
  const takenHelp = "C0999888777";
  const takenOrg = "G0999888777";

  await insertHostedProgram({
    id: existingProgId,
    workspaceId: "T_CENTRAL",
    programName: "Existing Program",
    ownerHcaId: "H_PREV",
    ownerSlackId: null,
  });
  await claimHostedChannels({
    workspaceId: "T_CENTRAL",
    programId: existingProgId,
    channels: [
      { id: takenHelp, kind: "help" },
      { id: takenOrg, kind: "organizer" },
    ],
    claimedByHcaId: "H_PREV",
  });

  // Attempting to claim taken help channel
  const resHelp = await validateActivationGuards({
    ...baseValidInput,
    programSlug: "new-prog-1",
    helpChannelId: takenHelp,
    organizerChannelId: "G0111222333",
  });
  expect(resHelp.ok).toBe(false);
  expect(resHelp.error).toMatch(/is already claimed by program "existing-prog"/i);

  // Attempting to claim taken organizer channel
  const resOrg = await validateActivationGuards({
    ...baseValidInput,
    programSlug: "new-prog-2",
    helpChannelId: "C0111222333",
    organizerChannelId: takenOrg,
  });
  expect(resOrg.ok).toBe(false);
  expect(resOrg.error).toMatch(/is already claimed by program "existing-prog"/i);
});

test("guard: program name & slug customization", async () => {
  // Empty name
  const emptyName = await validateActivationGuards({
    ...baseValidInput,
    programName: "",
  });
  expect(emptyName.ok).toBe(false);
  expect(emptyName.error).toMatch(/program name is required/i);

  // Over 80 chars
  const longName = await validateActivationGuards({
    ...baseValidInput,
    programName: "A".repeat(81),
  });
  expect(longName.ok).toBe(false);
  expect(longName.error).toMatch(/under 80 characters/i);

  // Custom valid slug
  const validCustom = await validateActivationGuards({
    ...baseValidInput,
    programSlug: "custom-slug-123",
  });
  expect(validCustom.ok).toBe(true);
  expect(validCustom.validatedSlug).toBe("custom-slug-123");

  // Invalid custom slug
  const invalidCustom = await validateActivationGuards({
    ...baseValidInput,
    programSlug: "INVALID SLUG!",
  });
  expect(invalidCustom.ok).toBe(false);
});

test("guard: support avatar/icon URL validation", async () => {
  // Non-https
  const insecure = await validateActivationGuards({
    ...baseValidInput,
    iconUrl: "http://example.com/icon.png",
  });
  expect(insecure.ok).toBe(false);
  expect(insecure.error).toMatch(/must be a secure https:\/\/ URL/i);

  // Private network SSRF icon
  const ssrfIcon = await validateActivationGuards({
    ...baseValidInput,
    iconUrl: "https://10.0.0.1/icon.png",
  });
  expect(ssrfIcon.ok).toBe(false);
  expect(ssrfIcon.error).toMatch(/icon URL rejected/i);

  // Valid https icon
  const validIcon = await validateActivationGuards({
    ...baseValidInput,
    iconUrl: "https://assets.hackclub.com/icon.png",
  });
  expect(validIcon.ok).toBe(true);
});

test("security: no secret leakage in activation errors or results", async () => {
  const secretKeywords = ["token", "xoxb-", "xapp-", "secret", "bearer", "password"];
  const res = await validateActivationGuards({
    ...baseValidInput,
    helpChannelId: "invalid",
  });
  expect(res.ok).toBe(false);
  const errMsg = (res.error || "").toLowerCase();
  for (const kw of secretKeywords) {
    expect(errMsg.includes(kw)).toBe(false);
  }
});
