type TestAny = any;
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const brand = require("./brand");
const { manifest, BOT_SCOPES } = require("../scripts/manifest.cjs");

function registeredCommands() {
  const found: string[] = [];
  require("./commands").register({
    command: (name: TestAny) => found.push(name),
    shortcut: () => {},
    action: () => {},
    view: () => {},
    event: () => {},
  });
  return found;
}

function withBrand(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the manifest advertises exactly the commands the bot listens for", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const advertised = manifest().features.slash_commands.map((c: TestAny) => c.command);
    const registered = registeredCommands();

    const onlyManifest = advertised.filter((c: TestAny) => !registered.includes(c));
    const onlyEngine = registered.filter((c: TestAny) => !advertised.includes(c));

    assert.deepEqual(onlyManifest, [], "advertised but not listened for — silently does nothing");
    assert.deepEqual(onlyEngine, [], "listened for but not advertised — unreachable");
  });
});

test("commands and the shortcut id follow the bot's slug", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const m = manifest();
    assert.equal(m.display_information.name, "Sol");
    assert.equal(m.features.bot_user.display_name, "Sol");
    assert.equal(m.features.shortcuts[0].callback_id, "sol_teach_thread");
    assert.ok(m.features.slash_commands.every((c: TestAny) => c.command === "/sol" || c.command.startsWith("/sol-")));
  });
});


test("no unprefixed command is advertised", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const advertised = manifest().features.slash_commands.map((c: TestAny) => c.command);
    assert.ok(!advertised.includes("/guide"));
  });
});

test("no two advertised commands share a name", () => {
  const advertised = manifest().features.slash_commands.map((c: TestAny) => c.command);
  assert.equal(new Set(advertised).size, advertised.length);
});

test("with nothing set the manifest is pixie's own", () => {
  withBrand({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    const advertised = manifest().features.slash_commands.map((c: TestAny) => c.command);
    assert.equal(manifest().display_information.name, "pixie");
    assert.ok(advertised.includes("/pixie"));
    assert.ok(advertised.includes("/pixie-teach"));
  });
});


test("socket mode, interactivity and the home tab stay enabled", () => {
  const m = manifest();
  assert.equal(m.settings.socket_mode_enabled, true);
  assert.equal(m.settings.interactivity.is_enabled, true);
  assert.equal(m.features.app_home.home_tab_enabled, true);
});

test("the scopes the bot actually calls are all requested", () => {
  for (const needed of [
    "chat:write",
    "channels:join",
    "channels:history",
    "commands",
    "reactions:write",
    "files:read",
    "im:write",
  ]) {
    assert.ok(BOT_SCOPES.includes(needed), `missing scope ${needed}`);
  }
});

test("the manifest is valid JSON at any brand", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol Helper Bot", PIXIE_BOT_SLUG: undefined }, () => {
    const round = JSON.parse(JSON.stringify(manifest()));
    assert.equal(round.features.slash_commands[0].command, "/sol-helper-bot");
    assert.equal(brand.slug(), "sol-helper-bot");
  });
});
export {};
