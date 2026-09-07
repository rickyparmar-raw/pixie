// Static guard: the hosted onboarding path must never collect per-program
// Slack tokens, signing secrets, or model keys. If a future change re-adds a
// token field to these files, this test names it. Comments/docs mentioning
// Railway in prose are fine — identifier collection is what is forbidden.
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const HOSTED_FILES = [
  "app/wizard/hostedActions.ts",
  "app/wizard/_components/HostedSetupView.tsx",
  "lib/programClaim.ts",
  "lib/deployment.ts",
  "lib/activationGuards.ts",
];

const FORBIDDEN_IDENTIFIERS = [
  "botToken",
  "appToken",
  "slack_bot_token",
  "slack_app_token",
  "signing secret",
  "HCAI_API_KEY",
  "provisionTrial",
  "createProjectAndService",
  "xoxb-",
  "xapp-",
];

test("hosted flow collects no per-program secrets and provisions nothing", () => {
  for (const file of HOSTED_FILES) {
    const src = readFileSync(join(import.meta.dir, "..", file), "utf8");
    for (const ident of FORBIDDEN_IDENTIFIERS) {
      expect(src.includes(ident), `${file} must not contain ${ident}`).toBe(false);
    }
  }
});
