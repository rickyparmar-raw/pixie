import { test, expect, mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createTestDb } from "./pgTestDb";
import type { WizardSession } from "./session";

// Server-action tests with every external seam stubbed: fresh pg-mem per
// test, a controllable Wizard session, no Core network (mutable mock), and
// Next's cache/navigation reduced to recorded no-ops.

let currentSession: WizardSession | null = null;
const coreMode: {
  configured: boolean;
  membership: (id: string) => { ok: boolean; hasAccess: boolean; isArchived?: boolean };
  sync: (id: string, payload: Record<string, unknown>) => { ok: boolean; error?: string };
  testAnswer: unknown;
} = {
  configured: false,
  membership: () => ({ ok: true, hasAccess: true }),
  sync: () => ({ ok: true }),
  testAnswer: null,
};
const synced: Array<{ id: string; payload: Record<string, unknown> }> = [];
let redirectedTo: string | null = null;

mock.module("@/lib/db", () => createTestDb());
mock.module("@/lib/session", () => ({
  getSession: async () => currentSession,
  // Faithful copy of the real ownsIdentifier (case-insensitive HCA/email
  // match) — the mock must stand in for next/headers-backed session reads.
  ownsIdentifier: (identifier: string | null | undefined, s: { hcaId: string; email: string }) => {
    if (!identifier) return false;
    const id = identifier.trim().toLowerCase();
    return !!id && (id === s.hcaId.toLowerCase() || id === s.email.toLowerCase());
  },
  isCreatorAllowed: (identity: { hcaId: string; email: string }) => {
    const raw = (process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST ?? "").trim();
    if (!raw) return false;
    const entries = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const email = identity.email.toLowerCase();
    const domain = email.split("@")[1];
    return entries.some((e) => e === identity.hcaId.toLowerCase() || e === email || (domain && e === domain));
  },
  isAllowed: () => true,
}));
mock.module("@/lib/pixieCore", () => {
  // hostedActions static-imports every name below — a missing export fails
  // at link time, so unused actions get no-op stubs, not omissions.
  const noop = async () => ({ ok: true });
  return {
    coreConfigured: () => coreMode.configured,
    coreChannelMembership: async (id: string) => coreMode.membership(id),
    syncProgramToCore: async (id: string, payload: Record<string, unknown>) => {
      synced.push({ id, payload });
      return coreMode.sync(id, payload);
    },
    coreHelpersSync: async () => ({ ok: true }),
    coreHelpers: async () => [],
    coreRoutingExpertise: async () => ({ ok: true }),
    coreTestQuestion: async () => {
      if (coreMode.testAnswer instanceof Error) throw coreMode.testAnswer;
      return coreMode.testAnswer;
    },
    coreTicketAction: noop,
    coreTicketReply: noop,
    coreTicketNote: noop,
    coreCopilot: noop,
    coreKnowledgePropose: noop,
    coreKnowledgeReview: noop,
    coreFaqPropose: noop,
    coreMacroSave: noop,
    coreMacroDelete: noop,
    coreMacroSend: noop,
    coreIncidentDetect: noop,
    coreIncidentAction: noop,
    coreIncidentNotify: noop,
    coreRadarEvaluate: noop,
    coreRadarAction: noop,
    coreRetentionPolicy: noop,
    coreRetentionSweep: noop,
    coreTicketSearch: noop,
    coreTicketDetail: noop,
  };
});
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("next/navigation", () => ({
  redirect: (url: string) => {
    redirectedTo = url;
  },
}));

const MIGRATIONS = ["003_behavior_runtime_status.sql", "004_helper_ping_eligibility.sql"].map((f) =>
  readFileSync(join(import.meta.dir, "..", "db", "migrations", f), "utf8"),
);

function ownerSession(): WizardSession {
  return { hcaId: "H_CREATOR", email: "creator@example.com", name: "Creator", slackId: "U_CREATOR", exp: 9999999999 };
}

async function setup() {
  mock.module("@/lib/db", () => createTestDb());
  const { query } = await import("./db");
  for (const sql of MIGRATIONS) await query(sql);
  synced.length = 0;
  redirectedTo = null;
  coreMode.configured = false;
  coreMode.membership = () => ({ ok: true, hasAccess: true });
  coreMode.sync = () => ({ ok: true });
  coreMode.testAnswer = null;
  process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST = "example.com";
  currentSession = ownerSession();
  return { query };
}

test("createSandboxProgram: happy path persists sandbox state, claims channels, syncs behavior+status", async () => {
  await setup();
  const { createSandboxProgram } = await import("@/app/wizard/hostedActions");
  const { getHostedProgram, listHostedChannels, listHostedHelpers } = await import("./hostedPrograms");

  const res = await createSandboxProgram({
    programName: "Sandbox Prog",
    programSlug: null,
    programDescription: "A sandbox program",
    supportName: null,
    iconUrl: "https://cdn.example.com/icon.png",
    mainChannelId: "C11111111",
    helpChannelId: "C22222222",
    behavior: { main: { ambientProgramReplies: false }, help: { aiReplies: true } },
    sources: [
      { type: "url", url: "https://docs.example.com", label: "Docs" },
      { type: "text", label: "Pasted notes", content: "Refund window is 30 days." },
    ],
    helpers: [
      { slackUserId: "U99999999", role: "helper", expertise: ["refunds", "shipping"], eligibleForPings: true },
      { slackUserId: "U88888888", role: "organizer", expertise: [], eligibleForPings: false },
    ],
  });

  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const program = await getHostedProgram(res.programId);
  expect(program?.runtime_status).toBe("sandbox");
  expect(program?.behavior).toEqual({
    main: expect.objectContaining({ ambientProgramReplies: false }),
    help: expect.objectContaining({ aiReplies: true }),
  });
  // Unknown behavior keys never reach storage.
  expect(JSON.stringify(program?.behavior)).not.toContain("evilKey");
  expect(program?.sources).toHaveLength(2);

  const channels = await listHostedChannels(res.programId);
  expect(channels.map((c) => [c.channel_id, c.kind]).sort()).toEqual([
    ["C11111111", "discussion"],
    ["C22222222", "help"],
  ]);

  const helpers = await listHostedHelpers(res.programId);
  expect(helpers.find((h) => h.slack_user_id === "U99999999")?.role).toBe("helper");
  expect(helpers.find((h) => h.slack_user_id === "U88888888")?.role).toBe("organizer");
  expect(helpers.find((h) => h.slack_user_id === "U88888888")?.eligible_for_pings).toBe(false);

  expect(synced).toHaveLength(1);
  expect(synced[0].payload.status).toBe("sandbox");
  expect((synced[0].payload.behavior as Record<string, unknown>).main).toMatchObject({ ambientProgramReplies: false });
});

test("createSandboxProgram: needs at least one channel; main and help must differ", async () => {
  await setup();
  const { createSandboxProgram } = await import("@/app/wizard/hostedActions");
  const base = {
    programName: "No Channels",
    sources: [{ type: "url" as const, url: "https://docs.example.com" }],
    helpers: [],
  };
  expect((await createSandboxProgram({ ...base, mainChannelId: null, helpChannelId: null })).ok).toBe(false);
  const same = await createSandboxProgram({ ...base, mainChannelId: "C11111111", helpChannelId: "C11111111" });
  expect(same.ok).toBe(false);
  if (!same.ok) expect(same.error).toMatch(/different/);
  // Help-only is fine — main is optional.
  const helpOnly = await createSandboxProgram({ ...base, programName: "Help Only", mainChannelId: null, helpChannelId: "C33333333" });
  expect(helpOnly.ok).toBe(true);
});

test("createSandboxProgram: bad slug rejected; channel conflict names the channel and leaves no orphan", async () => {
  await setup();
  const { query } = await import("./db");
  const { createSandboxProgram } = await import("@/app/wizard/hostedActions");
  const { getHostedProgram } = await import("./hostedPrograms");

  const badSlug = await createSandboxProgram({
    programName: "Bad Slug",
    programSlug: "Bad_Slug!",
    sources: [{ type: "url", url: "https://docs.example.com" }],
    helpers: [],
    mainChannelId: null,
    helpChannelId: "C44444444",
  });
  expect(badSlug.ok).toBe(false);

  const first = await createSandboxProgram({
    programName: "First Prog",
    sources: [{ type: "url", url: "https://docs.example.com" }],
    helpers: [],
    mainChannelId: null,
    helpChannelId: "C55555555",
  });
  expect(first.ok).toBe(true);

  const clash = await createSandboxProgram({
    programName: "Second Prog",
    sources: [{ type: "url", url: "https://docs.example.com" }],
    helpers: [],
    mainChannelId: null,
    helpChannelId: "C55555555",
  });
  expect(clash.ok).toBe(false);
  if (!clash.ok) expect(clash.error).toContain("C55555555");
  expect(await getHostedProgram("second-prog")).toBeNull();
  const { rows } = await query<{ count: string }>(`select count(*) as count from hosted_programs`);
  expect(Number(rows[0].count)).toBe(1);
});

test("createSandboxProgram: Pixie membership verified live — no membership, no program", async () => {
  await setup();
  coreMode.configured = true;
  coreMode.membership = () => ({ ok: true, hasAccess: false });
  const { createSandboxProgram } = await import("@/app/wizard/hostedActions");
  const { getHostedProgram } = await import("./hostedPrograms");
  const res = await createSandboxProgram({
    programName: "Lonely Prog",
    sources: [{ type: "url", url: "https://docs.example.com" }],
    helpers: [],
    mainChannelId: null,
    helpChannelId: "C66666666",
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toMatch(/invite @Pixie/);
  expect(await getHostedProgram("lonely-prog")).toBeNull();
});

test("settings/sources/channels/launch: owner and organizer may edit, helper and stranger may not", async () => {
  await setup();
  const { query } = await import("./db");
  const actions = await import("@/app/wizard/hostedActions");
  const { insertHostedProgram } = await import("./programClaim");

  await insertHostedProgram({ id: "perm-prog", workspaceId: "default", programName: "Perm", ownerHcaId: "H_OWNER", ownerSlackId: "U_OWNER" });
  await query(`update hosted_programs set runtime_status = 'sandbox' where id = 'perm-prog'`);
  await query(
    `insert into hosted_program_helpers (program_id, slack_user_id, role, active) values
     ('perm-prog','U_ORG','organizer',true), ('perm-prog','U_HELP','helper',true)`,
  );
  const fd = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("programId", "perm-prog");
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };

  // Owner saves settings.
  currentSession = { hcaId: "H_OWNER", email: "owner@example.com", name: "Owner", slackId: "U_OWNER", exp: 9999999999 };
  const ownerSave = await actions.saveHostedSettings({ error: null }, fd({ "behavior.main.ambientProgramReplies": "off" }));
  expect(ownerSave.error).toBeNull();

  // Organizer saves settings too.
  currentSession = { hcaId: "H_ORG", email: "org@example.com", name: "Org", slackId: "U_ORG", exp: 9999999999 };
  const orgSave = await actions.saveHostedSettings({ error: null }, fd({ "behavior.main.ambientProgramReplies": "on" }));
  expect(orgSave.error).toBeNull();

  // Helper gets an inline denial on settings, sources, channels, and launch.
  currentSession = { hcaId: "H_HELP", email: "help@example.com", name: "Help", slackId: "U_HELP", exp: 9999999999 };
  expect((await actions.saveHostedSettings({ error: null }, fd())).error).toMatch(/owner or an admin/);
  expect((await actions.saveHostedSources({ error: null }, fd())).error).toMatch(/owner or an admin/);
  expect((await actions.hostedChannelsUpdate({ error: null }, fd({ newHelpChannelId: "C77777777" }))).error).toMatch(/owner or an admin/);
  expect((await actions.launchProgramAction({ error: null }, fd({ confirm: "launch" }))).error).toMatch(/owner or an admin/);

  // Signed-in stranger (no membership at all) is denied the same way.
  currentSession = { hcaId: "H_STRANGER", email: "stranger@example.com", name: "Stranger", slackId: "U_STRANGER", exp: 9999999999 };
  expect((await actions.saveHostedSettings({ error: null }, fd())).error).toMatch(/owner or an admin/);

  // Organizer launches sandbox → live and syncs status live.
  currentSession = { hcaId: "H_ORG", email: "org@example.com", name: "Org", slackId: "U_ORG", exp: 9999999999 };
  const launched = await actions.launchProgramAction({ error: null }, fd({ confirm: "launch" }));
  expect(launched.error).toBeNull();
  expect(redirectedTo).toBe("/programs/perm-prog");
  const { getHostedProgram } = await import("./hostedPrograms");
  expect((await getHostedProgram("perm-prog"))?.runtime_status).toBe("live");
  expect(synced[synced.length - 1].payload.status).toBe("live");

  // Launch without the confirmation checkbox is rejected.
  expect((await actions.launchProgramAction({ error: null }, fd())).error).toMatch(/confirmation/);
});

test("askTestQuestion: members get the Core probe, strangers do not", async () => {
  await setup();
  const actions = await import("@/app/wizard/hostedActions");
  const { insertHostedProgram } = await import("./programClaim");
  await insertHostedProgram({ id: "probe-prog", workspaceId: "default", programName: "Probe", ownerHcaId: "H_OWNER", ownerSlackId: "U_OWNER" });
  coreMode.testAnswer = { ok: true, expectedAction: "reply", grounded: true };

  currentSession = { hcaId: "H_OWNER", email: "owner@example.com", name: "Owner", slackId: "U_OWNER", exp: 9999999999 };
  const ok = await actions.askTestQuestion({ programId: "probe-prog", question: "how do refunds work?", role: "help" });
  expect(ok.ok).toBe(true);

  currentSession = { hcaId: "H_STRANGER", email: "s@example.com", name: "S", slackId: "U_STRANGER", exp: 9999999999 };
  const denied = await actions.askTestQuestion({ programId: "probe-prog", question: "how do refunds work?", role: "help" });
  expect(denied.ok).toBe(false);

  currentSession = { hcaId: "H_NOLINK", email: "n@example.com", name: "N", slackId: null, exp: 9999999999 };
  const unlinked = await actions.askTestQuestion({ programId: "probe-prog", question: "hi?", role: "help" });
  expect(unlinked.ok).toBe(false);
});
