const { test, expect } = require("bun:test");
const model = require("./programModel");

test("a fresh program gets the spec defaults for both channel roles", () => {
  const b = model.behaviorFor({ id: "x" });
  expect(b.main).toEqual({ ...model.MAIN_DEFAULTS });
  expect(b.help.ticketsEnabled).toBe(true);
  expect(b.help.autoCreateTickets).toBe(true);
  expect(b.help.escalateUnknown).toBe(true);
  expect(b.help.expertiseRouting).toBe(true);
  expect(b.main.ticketsEnabled).toBe(false);
  expect(b.main.helperEscalationEnabled).toBe(false);
  expect(b.main.ambientProgramReplies).toBe(true);
});

test("legacy flags carry over so a migrated program keeps its behavior", () => {
  const b = model.behaviorFor({
    id: "acme",
    posture: "passive",
    ticketsEnabled: false,
    helperPing: true,
    aiAnswers: true,
  });
  expect(b.help.ticketsEnabled).toBe(false);
  expect(b.help.helperPings).toBe(true);
  expect(b.main.generalMentionChat).toBe(false);
});

test("legacy helperPing defaults off (it was opt-in)", () => {
  expect(model.behaviorFor({ id: "b2b" }).help.helperPings).toBe(false);
});

test("muted posture disables both roles and reads as paused", () => {
  const p = { id: "m", posture: "muted" };
  const b = model.behaviorFor(p);
  expect(b.main.enabled).toBe(false);
  expect(b.help.enabled).toBe(false);
  expect(model.statusFor(p)).toBe("paused");
});

test("stored behavior overrides legacy flags key by key", () => {
  const b = model.behaviorFor({
    id: "x",
    ticketsEnabled: false,
    behavior: { help: { ticketsEnabled: true }, main: { ambientProgramReplies: false } },
  });
  expect(b.help.ticketsEnabled).toBe(true);
  expect(b.main.ambientProgramReplies).toBe(false);
  expect(b.main.mentionReplies).toBe(true);
});

test("stored behavior may arrive as a JSON string", () => {
  expect(model.behaviorFor({ id: "x", behavior: '{"main":{"enabled":false}}' }).main.enabled).toBe(false);
});

test("sanitizeBehaviorPatch drops unknown keys and non-boolean values", () => {
  const clean = model.sanitizeBehaviorPatch({
    main: { enabled: "false", evil: true, ambientProgramReplies: "maybe" },
    help: { helperPings: 1 },
    other: { x: 1 },
  });
  expect(clean).toEqual({ main: { enabled: false }, help: { helperPings: true } });
});

test("mergeBehavior patches without dropping existing keys", () => {
  const merged = model.mergeBehavior(
    { main: { enabled: false }, help: { aiReplies: false } },
    { help: { ticketsEnabled: false } },
  );
  expect(merged).toEqual({ main: { enabled: false }, help: { aiReplies: false, ticketsEnabled: false } });
});

test("statusFor honors explicit status and defaults to live", () => {
  expect(model.statusFor({ status: "sandbox" })).toBe("sandbox");
  expect(model.statusFor({ status: "bogus" })).toBe("live");
});

test("the current production shape validates cleanly", () => {
  const r = model.validateChannelRoles({
    programs: [
      { id: "acme", helpChannel: "C0B6STY9G5N", channels: ["C0B6STY9G5N", "C0B5P4N0WHH", "C0BK4F6STFZ"] },
      { id: "beta", helpChannel: "C0BMHSDL597", channels: ["C0BMHSDL597"] },
    ],
    legacyHelp: "C0B6STY9G5N",
    legacyMain: ["C0B5P4N0WHH", "C0BK4F6STFZ"],
  });
  expect(r).toEqual({ ok: true, errors: [] });
});

test("a channel that is main in config but help via env is a conflict", () => {
  const r = model.validateChannelRoles({
    programs: [{ id: "acme", helpChannel: "CHELP", channels: ["CHELP", "C0BK4F6STFZ"] }],
    legacyHelp: "C0BK4F6STFZ",
  });
  expect(r.ok).toBe(false);
  expect(r.errors[0].channelId).toBe("C0BK4F6STFZ");
});

test("two programs claiming one channel is a conflict regardless of order", () => {
  const a = { id: "a", helpChannel: null, channels: ["C1"] };
  const b = { id: "b", helpChannel: "C1", channels: [] };
  expect(model.validateChannelRoles({ programs: [a, b] }).ok).toBe(false);
  expect(model.validateChannelRoles({ programs: [b, a] }).ok).toBe(false);
});

test("same channel id in different workspaces is not a conflict", () => {
  const r = model.validateChannelRoles({
    programs: [
      { id: "a", workspaceId: "T1", helpChannel: "C1", channels: [] },
      { id: "b", workspaceId: "T2", channels: ["C1"] },
    ],
  });
  expect(r.ok).toBe(true);
});

test("a channel in both SLACK_HELP_CHANNEL and SLACK_FAQ_CHANNELS is a conflict", () => {
  expect(model.validateChannelRoles({ programs: [], legacyHelp: "C1", legacyMain: ["C1"] }).ok).toBe(false);
});

test("a hosted claim that disagrees with config is a conflict", () => {
  const r = model.validateChannelRoles({
    programs: [{ id: "acme", channels: ["C1"] }],
    claims: [{ workspace_id: "default", channel_id: "C1", program_id: "acme", kind: "help" }],
  });
  expect(r.ok).toBe(false);
});

test("a hosted claim agreeing with config is fine", () => {
  const r = model.validateChannelRoles({
    programs: [{ id: "acme", helpChannel: "C1", channels: ["C1"] }],
    claims: [{ workspace_id: "default", channel_id: "C1", program_id: "acme", kind: "help" }],
  });
  expect(r.ok).toBe(true);
});

test("organizer channels: own role; a hosted organizer claim on a listed channel is not a conflict", () => {
  const r = model.validateChannelRoles({
    programs: [{ id: "hw", workspaceId: "T1", helpChannel: "CH", organizerChannel: null, channels: ["CORG", "CH"] }],
    claims: [
      { workspace_id: "T1", channel_id: "CH", program_id: "hw", kind: "help" },
      { workspace_id: "T1", channel_id: "CORG", program_id: "hw", kind: "organizer" },
    ],
  });
  expect(r.ok).toBe(true);
  const bad = model.validateChannelRoles({
    programs: [
      { id: "a", organizerChannel: "C1", channels: [] },
      { id: "b", channels: ["C1"] },
    ],
  });
  expect(bad.ok).toBe(false);
});
export {};
