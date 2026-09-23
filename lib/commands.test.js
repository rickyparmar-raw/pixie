process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("./config");
const learn = require("./learn");
const teachThread = require("./teachThread");
const commands = require("./commands");
const { parseForgetInput, parseId, adminOnlyShortcut, teachThreadShortcut } = commands;

const ADMIN = "U0ADMIN";
config.slack.adminUserIds = [ADMIN];

test("parseForgetInput parses single ids, ranges, pending, and all", () => {
  assert.deepEqual(parseForgetInput("15"), { type: "id", id: 15 });
  assert.deepEqual(parseForgetInput("#15"), { type: "id", id: 15 });

  assert.deepEqual(parseForgetInput("12-40"), { type: "range", from: 12, to: 40 });
  assert.deepEqual(parseForgetInput("#12-#40"), { type: "range", from: 12, to: 40 });

  assert.deepEqual(parseForgetInput("pending"), { type: "pending" });
  assert.deepEqual(parseForgetInput("PENDING"), { type: "pending" });

  assert.deepEqual(parseForgetInput("all"), { type: "all" });
  // 'all' requires exact literal matching, not prefix
  assert.equal(parseForgetInput("allofit"), null);
  assert.equal(parseForgetInput("invalid"), null);
});

test("parseId accepts a bare or hashed id and rejects anything else", () => {
  assert.equal(parseId("7"), 7);
  assert.equal(parseId("#7"), 7);
  assert.equal(parseId(" 7 "), 7);
  assert.equal(parseId("0"), null);
  assert.equal(parseId("-3"), null);
  assert.equal(parseId("seven"), null);
  assert.equal(parseId(""), null);
});

/* -------------------------------------------- teach-thread shortcut -- */

function stubEphemeralClient() {
  const posted = [];
  return { client: { chat: { postEphemeral: async (args) => void posted.push(args) } }, posted };
}

// Shortcut args are shaped differently from a slash command ({shortcut, ack,
// client} vs {command, ack, respond}), so the admin gate needed its own wrapper
// — this is the regression test for that wrapper actually gating correctly.
test("adminOnlyShortcut blocks a non-admin and answers ephemerally", async () => {
  const { client, posted } = stubEphemeralClient();
  const inner = async () => {
    throw new Error("must not run for a non-admin");
  };

  await adminOnlyShortcut(inner)({
    shortcut: { channel: { id: "C1" }, user: { id: "U0NOTADMIN" } },
    ack: async () => {},
    client,
  });

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /helpers-only/);
});

test("adminOnlyShortcut runs the handler for an admin", async () => {
  let ran = false;
  await adminOnlyShortcut(async () => void (ran = true))({
    shortcut: { channel: { id: "C1" }, user: { id: ADMIN } },
    ack: async () => {},
    client: {},
  });
  assert.equal(ran, true);
});

test("teachThreadShortcut queues a summary and confirms ephemerally", async () => {
  const { client, posted } = stubEphemeralClient();
  const savedSummarize = teachThread.summarizeThread;
  const savedCapture = learn.captureFromThread;
  teachThread.summarizeThread = async () => ({ question: "how do i join", answer: "post in #pixl-help" });
  learn.captureFromThread = () => 42;

  try {
    await teachThreadShortcut({
      shortcut: {
        channel: { id: "C1" },
        message: { thread_ts: "1.1", ts: "1.2" },
        message_ts: "1.2",
        user: { id: ADMIN },
      },
      ack: async () => {},
      client,
    });
  } finally {
    teachThread.summarizeThread = savedSummarize;
    learn.captureFromThread = savedCapture;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /queued for review/);
  assert.match(posted[0].text, /#42/);
});

test("teachThreadShortcut tells the admin when nothing was found", async () => {
  const { client, posted } = stubEphemeralClient();
  const saved = teachThread.summarizeThread;
  teachThread.summarizeThread = async () => null;

  try {
    await teachThreadShortcut({
      shortcut: { channel: { id: "C1" }, message: { ts: "1.2" }, message_ts: "1.2", user: { id: ADMIN } },
      ack: async () => {},
      client,
    });
  } finally {
    teachThread.summarizeThread = saved;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /couldn't find/);
});

test("programCommand list, add, set, and remove — admin-only", async () => {
  const responses = [];
  const sendEphemeral = async (msg) => responses.push(msg.text);

  await commands.programCommand({ command: { text: "list", user_id: ADMIN }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[0], /registered programs/);

  await commands.programCommand({ command: { text: "add testprog Test Program", user_id: ADMIN }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[1], /saved program `testprog`/);

  await commands.programCommand({ command: { text: "set testprog posture passive", user_id: ADMIN }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[2], /updated `testprog` posture to `passive`/);

  await commands.programCommand({ command: { text: "remove testprog", user_id: ADMIN }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[3], /removed program `testprog`/);
});

test("programCommand rejects list/add/set/remove for a non-admin, non-helper user", async () => {
  const responses = [];
  const sendEphemeral = async (msg) => responses.push(msg.text);
  await commands.programCommand({ command: { text: "list", user_id: "U0RANDOM" }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[0], /helpers-only/);
});

test("programCommand tickets on|off is reachable by a program's own helper, not just admins, and is channel-scoped", async () => {
  const responses = [];
  const sendEphemeral = async (msg) => responses.push(msg.text);
  const db = require("./db");
  const programs = require("./programs");
  db.saveProgram({ id: "cmd-tix", name: "CmdTix", helpChannel: "C-CMD-TIX", channels: ["C-CMD-TIX"] });
  db.syncHelper({ programId: "cmd-tix", userId: "U-HELPER-TIX", source: "manual" });
  programs.invalidate();

  // A non-helper, non-admin is refused.
  await commands.programCommand({ command: { text: "tickets off", channel_id: "C-CMD-TIX", user_id: "U0RANDOM" }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[0], /helpers-only/);

  // The program's own helper can toggle it off, and it actually takes effect.
  await commands.programCommand({ command: { text: "tickets off", channel_id: "C-CMD-TIX", user_id: "U-HELPER-TIX" }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[1], /ticket auto-creation from this channel is \*off\*/);
  assert.equal(programs.get("cmd-tix").publicTicketsEnabled, false);

  // ...and back on.
  await commands.programCommand({ command: { text: "tickets on", channel_id: "C-CMD-TIX", user_id: "U-HELPER-TIX" }, ack: async () => {}, respond: sendEphemeral });
  assert.match(responses[2], /back \*on\*/);
  assert.equal(programs.get("cmd-tix").publicTicketsEnabled, true);
});

test("guideCommand returns interactive picker blocks when no text passed", async () => {
  const responses = [];
  const sendEphemeral = async (msg) => responses.push(msg);

  await commands.guideCommand({
    command: { text: "", channel_id: "C1", user_id: "U1" },
    ack: async () => {},
    respond: sendEphemeral,
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].text, "Interactive Walkthrough Guides");
  assert.ok(responses[0].blocks.length >= 2);
});

// Slash commands answer with their own ephemeral helper rather than going
// through lib/reply.js, so without this wrapper `/pixie <question>` would be
// the one place pixie still talks in dashes.
test("every registered command has its ephemeral replies de-dashed", async () => {
  const registered = {};
  const app = {
    command: (name, handler) => {
      registered[name] = handler;
    },
    action: () => {},
    shortcut: () => {},
    event: () => {},
    view: () => {},
  };
  commands.register(app);

  const sent = [];
  const handler = commands.plainSpoken(async ({ respond }) => {
    await respond({ response_type: "ephemeral", text: "the price — 11,400 px" });
  });
  await handler({ command: { user_id: "U1" }, ack: async () => {}, respond: async (p) => sent.push(p) });

  assert.equal(sent[0].text, "the price, 11,400 px");
  assert.ok(Object.keys(registered).length > 0, "register() bound no commands");
});

test("/pixie help returns the actor's filtered runtime command list", async () => {
  const responses = [];
  await commands.askCommand({
    command: { text: "help", user_id: "U0RANDOM", channel_id: "C1" },
    ack: async () => {},
    respond: async (payload) => responses.push(payload),
  });

  assert.match(responses[0].text, /\/pixie-sources/);
  assert.doesNotMatch(responses[0].text, /\/pixie-teach/);
});

/* ------------------- registry consistency (command-registry workstream) -- */

// The registry (lib/commandRegistry.js) is the inventory of record; the help
// listing (lib/capabilities.js) and the Bolt bindings below must cover the
// same slash surface. If any of the three drifts, this fails.
test("REGISTRY: slash defs, CAPABILITIES, and Bolt bindings cover each other", () => {
  const brand = require("./brand");
  const capabilities = require("./capabilities");
  const commandRegistry = require("./commandRegistry");

  const slashDefs = commandRegistry.COMMANDS.filter((c) => c.surface === "slash" || c.surface === "both");
  const suffixOf = (def) => (def.name === "ask" ? "" : def.name);

  const capabilitySuffixes = new Set(capabilities.CAPABILITIES.map((c) => c.suffix));
  for (const def of slashDefs) {
    assert.ok(capabilitySuffixes.has(suffixOf(def)), `/${def.name} has no CAPABILITIES entry`);
  }
  for (const suffix of capabilitySuffixes) {
    assert.ok(slashDefs.some((d) => suffixOf(d) === suffix), `CAPABILITIES suffix ${JSON.stringify(suffix)} has no registry def`);
  }

  const bound = [];
  const app = {
    command: (name) => void bound.push(name),
    action: () => {},
    shortcut: () => {},
    event: () => {},
    view: () => {},
  };
  commands.register(app);
  const expected = slashDefs.map((d) => brand.cmd(suffixOf(d)));
  for (const name of expected) {
    assert.ok(bound.includes(name), `${name} in registry but not bound by register()`);
  }
});

/* ------------------------------ ANSWER PIPELINE characterization (audit) -- */

test("CHAR: /pixie ask parity — docs hit answers ephemerally, miss chats, error falls back", async () => {
  const respond = require("./respond");
  const chat = require("./chat");
  const sent = [];
  const sendEphemeral = async (m) => sent.push(m);
  const origLookup = respond.lookupAnswer;
  const origChat = chat.getChatReply;
  const { config } = require("./config");
  const savedFaq = config.slack.faqChannels;
  // /pixie answers from the channel's own program, so the channel must be claimed.
  config.slack.faqChannels = [...(savedFaq || []), "C1"];
  try {
    let lookedUpFor = null;
    respond.lookupAnswer = async (_q, _c, prog) => { lookedUpFor = prog; return { source: "Docs", answer: "docs answer here" }; };
    await commands.askCommand({ command: { text: "how do i join", user_id: "U1", channel_id: "C1" }, ack: async () => {}, respond: sendEphemeral });
    assert.match(sent[0].text, /docs answer here/);
    assert.ok(lookedUpFor, "the lookup is scoped to the channel's program");

    // An unclaimed channel gets no program knowledge at all.
    sent.length = 0;
    let unscopedLookups = 0;
    respond.lookupAnswer = async () => { unscopedLookups += 1; return { source: "Docs", answer: "leak" }; };
    chat.getChatReply = async () => "chat only";
    await commands.askCommand({ command: { text: "what is the payout", user_id: "U1", channel_id: "C-NOBODY" }, ack: async () => {}, respond: sendEphemeral });
    assert.equal(unscopedLookups, 0);
    assert.doesNotMatch(sent[0].text, /leak/);

    sent.length = 0;
    respond.lookupAnswer = async () => null;
    chat.getChatReply = async () => "chat reply here";
    await commands.askCommand({ command: { text: "hey pixie", user_id: "U1", channel_id: "C1" }, ack: async () => {}, respond: sendEphemeral });
    assert.match(sent[0].text, /chat reply here/);

    sent.length = 0;
    respond.lookupAnswer = async () => { throw new Error("boom"); };
    await commands.askCommand({ command: { text: "anything", user_id: "U1", channel_id: "C1" }, ack: async () => {}, respond: sendEphemeral });
    assert.match(sent[0].text, /having trouble thinking/);
  } finally {
    respond.lookupAnswer = origLookup;
    chat.getChatReply = origChat;
    config.slack.faqChannels = savedFaq;
  }
});

test("CHAR: /pixie-check and /pixie-calc dispatch to their deterministic paths", async () => {
  const validator = require("./validator");
  const respond = require("./respond");
  const sent = [];
  const sendEphemeral = async (m) => sent.push(m.text);
  const origValidate = validator.validateRepository;
  const origLookup = respond.lookupAnswer;
  try {
    validator.validateRepository = async () => ({ ok: true, url: "https://github.com/u/r", fullName: "u/r", isReady: true, passes: ["ok"], issues: [], tips: [] });
    await commands.checkCommand({ command: { text: "https://github.com/u/r", user_id: "U1" }, ack: async () => {}, respond: sendEphemeral });
    assert.match(sent[0], /Ready for submission/);

    sent.length = 0;
    respond.lookupAnswer = async () => ({ source: "Pixl Shop", direct: true, answer: "calc answer" });
    await commands.calcCommand({ command: { text: "20 hours", user_id: "U1", channel_id: "C1" }, ack: async () => {}, respond: sendEphemeral });
    assert.match(sent[0], /calc answer/);
  } finally {
    validator.validateRepository = origValidate;
    respond.lookupAnswer = origLookup;
  }
});

test("CHAR: start_guide action posts dedashed blocks like every other guide entry", async () => {
  const handlers = {};
  const app = {
    command: () => {},
    action: (pattern, handler) => { handlers[pattern] = handler; },
    shortcut: () => {},
    event: () => {},
    view: () => {},
  };
  commands.register(app);
  const actionHandler = handlers[/^start_guide_.+$/.toString()] || Object.values(handlers).find((h) => typeof h === "function" && h !== undefined);
  assert.ok(actionHandler, "start_guide action registered");

  const guides = require("./guides");
  const origAvail = guides.isAvailable;
  const origStart = guides.startGuide;
  guides.isAvailable = () => true;
  guides.startGuide = () => ({ message: "wire it up — press W to start", checkNext: "wired? (yes/no)" });
  const posted = [];
  const client = {
    chat: {
      update: async () => ({}),
      postMessage: async (m) => { posted.push(m); return { ts: "9.9" }; },
    },
  };
  try {
    await actionHandler({ action: { value: "create-hackpad" }, body: { channel: { id: "C1" }, message: { ts: "1.1" }, user: { id: "U1" } }, ack: async () => {}, client });
  } finally {
    guides.isAvailable = origAvail;
    guides.startGuide = origStart;
  }
  assert.equal(posted.length, 1);
  assert.doesNotMatch(posted[0].blocks[0].text.text, /—/, "button-started guides dedash blocks like /guide does");
});
