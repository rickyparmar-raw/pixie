import { test, expect, afterEach } from "bun:test";
import { programSlugFor, creatorEligible } from "./programClaim";

const savedAllowlist = process.env.PIXIE_WIZARD_ALLOWLIST;
afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.PIXIE_WIZARD_ALLOWLIST;
  else process.env.PIXIE_WIZARD_ALLOWLIST = savedAllowlist;
});

test("programSlugFor derives a safe slug or rejects", () => {
  expect(programSlugFor("Highway")).toBe("highway");
  expect(programSlugFor("Solvable!")).toBe("solvable");
  expect(() => programSlugFor("x")).toThrow();
  expect(() => programSlugFor("has space and $ymbols ok")).not.toThrow();
});

test("creator eligibility follows the allowlist, defaulting open", () => {
  delete process.env.PIXIE_WIZARD_ALLOWLIST;
  const session = { hcaId: "U1", email: "a@example.com", name: "A", slackId: null, exp: 9999999999 };
  expect(creatorEligible(session)).toBe(true);

  process.env.PIXIE_WIZARD_ALLOWLIST = "owner@example.com";
  expect(creatorEligible(session)).toBe(false);
  expect(creatorEligible({ ...session, email: "owner@example.com" })).toBe(true);
});
