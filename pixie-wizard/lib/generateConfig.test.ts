import { test, expect } from "bun:test";
import { generateIdentityOverride, generateTrialEnv, redactEnvForSnapshot } from "./generateConfig";
import type { PixieTrialRow } from "./types";

function fixtureTrial(overrides: Partial<PixieTrialRow> = {}): PixieTrialRow {
  return {
    id: "trial-1",
    requester_hca_id: "hca-1",
    requester_email: "a@b.com",
    requester_name: "Alex",
    requester_slack_id: null,
    program_name: "Athena",
    program_description: null,
    bot_name: null,
    status: "awaiting_slack_credentials",
    railway_account_pool_id: null,
    railway_project_id: null,
    railway_service_id: null,
    railway_environment_id: null,
    slack_workspace_id: null,
    slack_workspace_name: null,
    slack_bot_user_id: null,
    channels: {},
    sources: [],
    config_snapshot: null,
    llm_base_url: null,
    llm_model: null,
    llm_key_encrypted: null,
    slack_bot_token_encrypted: null,
    slack_app_token_encrypted: null,
    created_at: "2026-01-01T00:00:00Z",
    expires_at: null,
    last_deploy_at: null,
    last_deploy_status: null,
    expiry_notified_at: null,
    paused_at: null,
    reclaim_deadline: null,
    deleted_at: null,
    ...overrides,
  };
}

const SECRETS = { botToken: "xoxb-fake", appToken: "xapp-fake", llmKey: "sk-fake" };

test("identity override names the program, not Pixl", () => {
  const text = generateIdentityOverride("Athena Bot", "Athena");
  expect(text).toMatch(/Athena/);
  expect(text).not.toMatch(/Ricky/i);
  expect(text).not.toMatch(/Pixorpheus/i);
});

test("default Zen base URL is omitted from the env, only the fallback landmine fix is set", () => {
  const env = generateTrialEnv(fixtureTrial(), SECRETS);
  expect(env.PIXIE_ANSWER_BASE_URL).toBeUndefined();
  expect(env.PIXIE_MODEL).toBeUndefined();
  expect(env.PIXIE_ANSWER_FALLBACK_BASE_URL).toBe("https://opencode.ai/zen/v1");
});

test("a custom base URL is carried through and mirrored into the fallback", () => {
  const env = generateTrialEnv(
    fixtureTrial({ llm_base_url: "https://my-gateway.example/v1", llm_model: "some-model" }),
    SECRETS,
  );
  expect(env.PIXIE_ANSWER_BASE_URL).toBe("https://my-gateway.example/v1");
  expect(env.PIXIE_MODEL).toBe("some-model");
  expect(env.PIXIE_ANSWER_FALLBACK_BASE_URL).toBe("https://my-gateway.example/v1");
});

test("help and faq channels are carried into SLACK_HELP_CHANNEL / SLACK_FAQ_CHANNELS", () => {
  const env = generateTrialEnv(
    fixtureTrial({
      channels: {
        helpChannel: { id: "C1", name: "help" },
        faqChannels: [{ id: "C2", name: "faq" }, { id: "C3", name: "general" }],
      },
    }),
    SECRETS,
  );
  expect(env.SLACK_HELP_CHANNEL).toBe("C1");
  expect(env.SLACK_FAQ_CHANNELS).toBe("C2,C3");
});

test("requester's slack id becomes the trial's own admin", () => {
  const env = generateTrialEnv(fixtureTrial({ requester_slack_id: "U999" }), SECRETS);
  expect(env.PIXIE_ADMIN_USER_IDS).toBe("U999");
});

test("no requester slack id means no admin — fails closed like pixie's own default", () => {
  const env = generateTrialEnv(fixtureTrial(), SECRETS);
  expect(env.PIXIE_ADMIN_USER_IDS).toBeUndefined();
});

test("redaction hides tokens and keys but leaves everything else readable", () => {
  const env = generateTrialEnv(fixtureTrial(), SECRETS);
  const redacted = redactEnvForSnapshot(env);
  expect(redacted.SLACK_BOT_TOKEN).toBe("(hidden)");
  expect(redacted.SLACK_APP_TOKEN).toBe("(hidden)");
  expect(redacted.OPENCODE_API_KEY).toBe("(hidden)");
  expect(redacted.PIXIE_IDENTITY_OVERRIDE).toBe(env.PIXIE_IDENTITY_OVERRIDE);
});
