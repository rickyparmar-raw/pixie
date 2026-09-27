process.env.PIXIE_DB_PATH = ":memory:";

// Registry tests pin parity between command definitions, matching, and authorization.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const registry = require("./commandRegistry");
const { COMMANDS, match, authorize, list, byName, byHandlerKey } = registry;

const BOT = "UBOT123";
const ADMIN = "U0ADMIN";
const HELPER = "U0HELPER";
const NORMAL = "U0NORMAL";

// Registry tests also protect the matching surface used by event handlers, not just the exported list.

test("every definition carries the full contract shape with valid enums", () => {
  assert.ok(COMMANDS.length >= 10, "registry must cover the whole inventory");
  for (const c of COMMANDS) {
    assert.equal(typeof c.name, "string", "name");
    assert.ok(Array.isArray(c.aliases), `${c.name}: aliases`);
    assert.ok(["slash", "text", "both"].includes(c.surface), `${c.name}: surface`);
    assert.ok(["anyone", "helper", "organizer"].includes(c.permission), `${c.name}: permission`);
    assert.ok(Array.isArray(c.channelRoles) && c.channelRoles.length > 0, `${c.name}: channelRoles`);
    for (const r of c.channelRoles) assert.ok(["main", "help", "dm"].includes(r), `${c.name}: role ${r}`);
    assert.equal(typeof c.usage, "string", `${c.name}: usage`);
    assert.equal(typeof c.description, "string", `${c.name}: description`);
    assert.equal(typeof c.handlerKey, "string", `${c.name}: handlerKey`);
  }
});

test("teach is split by surface because text and slash have different gates", () => {
  const teachDefs = COMMANDS.filter((c: any) => c.name === "teach");
  assert.equal(teachDefs.length, 2);
  assert.deepEqual(
    teachDefs.map((c: any) => [c.surface, c.permission]).sort(),
    [["slash", "organizer"], ["text", "helper"]],
  );
  assert.ok(teachDefs.every((c: any) => c.handlerKey === "teach"));
});

test("organizer commands are never executable by normal users", () => {
  for (const c of COMMANDS.filter((c: any) => c.permission === "organizer")) {
    const verdict = authorize(c, { userId: NORMAL, role: "help" });
    assert.equal(verdict.ok, false, `${c.name}/${c.surface} must deny a normal user`);
    assert.equal(verdict.reason, "not_organizer");
  }
});


test("match: text-form teach parity with handlers.teachPattern(false)", () => {
  const handlers = require("./handlers");
  const cases = [
    "!teach how do i join :: post in #pixl-help",
    "!TEACH x :: y",
    "  !teach",
    "pixie-teach x :: y",
    "/pixie-teach x :: y",
    "teach this thread",
    "teach thread",
    "teach this",
    "teach me something",
    "teach",
    "learn this",
    "remember that",
    "memorize it",
    "what does teach mean",
    "noteach x",
    "",
    "   ",
  ];
  for (const text of cases) {
    const expected = handlers.teachPattern(false).test(text);
    const got = match(text, { botUserId: BOT });
    assert.equal(!!(got && got.command.handlerKey === "teach"), expected, JSON.stringify(text));
  }
});

test("match: mention-form teach fires only after an explicit mention", () => {
  const handlers = require("./handlers");
  const mentionCases = [
    `<@${BOT}> teach this thread`,
    `<@${BOT}> teach how do i join :: ask a helper`,
    `<@${BOT}> learn this`,
    `<@${BOT}> remember that answer`,
    `<@${BOT}> memorize it`,
    `<@${BOT}> !teach x :: y`,
    `<@${BOT}> /pixie-teach x :: y`,
    `<@${BOT}|pixie> teach x`,
  ];
  for (const text of mentionCases) {
    const stripped = text.replace(new RegExp(`<@${BOT}(?:\\|[^>]+)?>`, "g"), "").trim();
    assert.equal(handlers.teachPattern(true).test(stripped), true, `setup: ${text}`);
    const got = match(text, { botUserId: BOT, botNames: ["pixie"] });
    assert.ok(got && got.command.handlerKey === "teach", `match: ${text}`);
  }
  for (const text of ["teach x", "learn this", "remember that", "memorize it", "please sum this"]) {
    assert.equal(match(text, { botUserId: BOT }), null, JSON.stringify(text));
  }
  assert.equal(match("<@UOTHER> teach x", { botUserId: BOT }), null);
});

test("match: teach args preserve the text after the trigger", () => {
  const got = match("!teach how do i join :: post in #pixl-help", { botUserId: BOT });
  assert.equal(got.command.handlerKey, "teach");
  assert.equal(got.args, "how do i join :: post in #pixl-help");
  const mentioned = match(`<@${BOT}> learn this thread`, { botUserId: BOT });
  assert.equal(mentioned.command.handlerKey, "teach");
  assert.equal(mentioned.args, "this thread");
});


test("match: text-form sum parity with handlers.sumPattern(false)", () => {
  const handlers = require("./handlers");
  const cases = [
    "!sum",
    "!sum public",
    "!summary",
    "!summarize",
    "!summarise",
    "pixie-sum",
    "/pixie-sum",
    "sum this",
    "sum thread",
    "summarize thread",
    "summarise thread",
    "summary of the rules",
    "what is the summary",
    "consume this",
    "presume innocence",
    "",
  ];
  for (const text of cases) {
    const expected = handlers.sumPattern(false).test(text);
    const got = match(text, { botUserId: BOT });
    assert.equal(!!(got && got.command.handlerKey === "sum"), expected, JSON.stringify(text));
  }
});

test("match: mention-form sum parity with handlers.sumPattern(true)", () => {
  const handlers = require("./handlers");
  const cases = [
    `<@${BOT}> sum`,
    `<@${BOT}> sum this`,
    `<@${BOT}> summary`,
    `<@${BOT}> summarize thread`,
    `<@${BOT}> summarise it`,
    `<@${BOT}> !sum public`,
    `<@${BOT}> /pixie-sum`,
  ];
  for (const text of cases) {
    const stripped = text.replace(new RegExp(`<@${BOT}(?:\\|[^>]+)?>`, "g"), "").trim();
    assert.equal(handlers.sumPattern(true).test(stripped), true, `setup: ${text}`);
    const got = match(text, { botUserId: BOT });
    assert.ok(got && got.command.handlerKey === "sum", `match: ${text}`);
  }
});


test("match: only the explicit !mute/!stfu command spellings route to mute", () => {
  assert.equal(match("!mute", { botUserId: BOT }).command.handlerKey, "mute");
  assert.equal(match("!stfu", { botUserId: BOT }).command.handlerKey, "mute");
  assert.equal(match(`<@${BOT}> !mute`, { botUserId: BOT }).command.handlerKey, "mute");
  const respond = require("./respond");
  assert.equal(respond.isMuteRequest("stfu pixie"), true, "setup: conversational shush exists");
  assert.equal(match("stfu pixie", { botUserId: BOT }), null);
  assert.equal(match("mute", { botUserId: BOT }), null);
  assert.equal(match("please be quiet pixie", { botUserId: BOT }), null);
});


test("match: guide text triggers mirror respond.isGuideMenuRequest", () => {
  const respond = require("./respond");
  const menuForms = ["!guide", "!guides", "/guide", "pixie guides", "pixie guide", "pixie-guide", "/pixie-guide"];
  for (const text of menuForms) {
    assert.equal(respond.isGuideMenuRequest(text), true, `setup: ${text}`);
    const got = match(text, { botUserId: BOT });
    assert.ok(got && got.command.handlerKey === "guide", `match: ${text}`);
    assert.equal(got.args, "");
  }
  const topic = match("pixie guide submitting my project", { botUserId: BOT });
  assert.ok(topic && topic.command.handlerKey === "guide");
  assert.equal(topic.args, "submitting my project");
  assert.equal(match(`<@${BOT}> !guide`, { botUserId: BOT }).command.handlerKey, "guide");
  assert.equal(match("guide", { botUserId: BOT }), null);
  assert.equal(match("nonsense", { botUserId: BOT }), null);
  assert.equal(match(`<@${BOT}> guide`, { botUserId: BOT }), null);
});


test("match: every own-slug command_bypass form reaches a registry command", () => {
  for (const text of ["!teach x :: y", "!sum", "!mute", "!stfu", "/pixie-teach x", "/pixie-sum"]) {
    assert.ok(match(text, { botUserId: BOT }), `bypass form with no registry match: ${text}`);
  }
});


test("authorize: helper text commands need helper or organizer", () => {
  const teachText = byName("teach", "text");
  const sum = byName("sum");
  assert.deepEqual(authorize(teachText, { userId: HELPER, isHelper: true, role: "help" }), { ok: true, reason: "allowed" });
  assert.deepEqual(authorize(sum, { userId: ADMIN, isOrganizer: true, role: "help" }), { ok: true, reason: "allowed" });
  assert.deepEqual(authorize(teachText, { userId: NORMAL, role: "help" }), { ok: false, reason: "not_helper" });
  assert.deepEqual(authorize(sum, { userId: NORMAL, role: "help" }), { ok: false, reason: "not_helper" });
});

test("authorize: slash teach stays organizer-only even for helpers", () => {
  const teachSlash = byName("teach", "slash");
  assert.deepEqual(authorize(teachSlash, { userId: HELPER, isHelper: true, role: "help" }), {
    ok: false,
    reason: "not_organizer",
  });
  assert.deepEqual(authorize(teachSlash, { userId: ADMIN, isOrganizer: true, role: "help" }), {
    ok: true,
    reason: "allowed",
  });
});

test("authorize: commandsEnabled=false blocks non-admin commands in main only", () => {
  const ask = byName("ask");
  const mute = byName("mute");
  const teachText = byName("teach", "text");
  const teachSlash = byName("teach", "slash");
  for (const cmd of [ask, mute]) {
    assert.deepEqual(authorize(cmd, { userId: NORMAL, role: "main", commandsEnabled: false }), {
      ok: false,
      reason: "commands_disabled",
    });
  }
  assert.deepEqual(authorize(teachText, { userId: HELPER, isHelper: true, role: "main", commandsEnabled: false }), {
    ok: false,
    reason: "commands_disabled",
  });
  assert.deepEqual(authorize(teachText, { userId: NORMAL, role: "main", commandsEnabled: false }), {
    ok: false,
    reason: "not_helper",
  });
  assert.deepEqual(authorize(teachSlash, { userId: ADMIN, isOrganizer: true, role: "main", commandsEnabled: false }), {
    ok: true,
    reason: "allowed",
  });
  assert.equal(authorize(ask, { userId: NORMAL, role: "help", commandsEnabled: false }).ok, true);
  assert.equal(authorize(ask, { userId: NORMAL, role: "dm", commandsEnabled: false }).ok, true);
  assert.equal(authorize(ask, { userId: NORMAL, role: "main" }).ok, true);
});

test("authorize: channel roles gate text commands, slash skips without a role", () => {
  const sum = byName("sum");
  assert.deepEqual(authorize(sum, { userId: HELPER, isHelper: true, role: "dm" }), {
    ok: false,
    reason: "wrong_channel",
  });
  assert.deepEqual(authorize(sum, { userId: HELPER, isHelper: true, role: "none" }), {
    ok: false,
    reason: "wrong_channel",
  });
  assert.equal(authorize(byName("ask"), { userId: NORMAL }).ok, true);
  assert.deepEqual(authorize("no-such-command", { userId: ADMIN, isOrganizer: true }), {
    ok: false,
    reason: "unknown_command",
  });
});

test("byHandlerKey resolves the architect's dispatch map", () => {
  assert.equal(byHandlerKey("teach").length, 2);
  assert.equal(byHandlerKey("teach", "text").length, 1);
  assert.equal(byHandlerKey("teach", "slash").length, 1);
  assert.equal(byHandlerKey("sum")[0].name, "sum");
  assert.equal(byHandlerKey("guide").length, 1);
});


test("list() renders a usage listing with the bot's own slash names", () => {
  const text = list();
  assert.match(text, /\/pixie-sources/);
  assert.match(text, /\/pixie-teach/);
  assert.match(text, /\/pixie-forget/);
  assert.match(text, /!sum/);
  assert.match(text, /!mute/);
  assert.match(text, /guide/);
});
export {};
