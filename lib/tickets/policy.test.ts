// @ts-nocheck
// Decision table for lib/tickets/policy.js: every settings combination that
// materially changes ticket/helper behavior gets one row. Pure — no Slack,
// no network, no DB writes (behaviorFor reads the passed object only).
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ticketPolicy, resolveTicketRole } = require("./policy");

function helpProg(help = {}) {
  return {
    id: "pol-help",
    posture: "active",
    helpChannel: "C-pol-help",
    channels: ["C-pol-help"],
    behavior: {
      help: {
        enabled: true,
        aiReplies: true,
        ticketsEnabled: true,
        autoCreateTickets: true,
        escalateUnknown: true,
        helperPings: true,
        expertiseRouting: true,
        ...help,
      },
    },
  };
}

function mainProg(main = {}) {
  return {
    id: "pol-main",
    posture: "active",
    helpChannel: "C-pol-main-help",
    channels: ["C-pol-main"],
    behavior: {
      main: {
        enabled: true,
        ambientProgramReplies: true,
        mentionReplies: true,
        generalMentionChat: true,
        commandsEnabled: true,
        ticketsEnabled: true,
        helperEscalationEnabled: true,
        ...main,
      },
    },
  };
}

const HELP_CASES = [
  {
    name: "help all on",
    patch: {},
    want: { createOnSupport: true, recordTicket: true, escalate: true, pingHelpers: true, expertiseRouting: true },
  },
  {
    name: "help enabled off kills everything",
    patch: { enabled: false },
    want: { createOnSupport: false, recordTicket: false, escalate: false, pingHelpers: false, expertiseRouting: false },
  },
  {
    name: "tickets off: no ticket at all, but opted-in helper pings still route (Pixl)",
    patch: { ticketsEnabled: false },
    want: { createOnSupport: false, recordTicket: false, escalate: false, pingHelpers: true, expertiseRouting: true },
  },
  {
    name: "auto-ticket off: record + escalate + ping, but no create-on-support",
    patch: { autoCreateTickets: false },
    want: { createOnSupport: false, recordTicket: true, escalate: true, pingHelpers: true, expertiseRouting: true },
  },
  {
    name: "escalation off: no waiting_for_helper move, pings still allowed for explicit escalation",
    patch: { escalateUnknown: false },
    want: { createOnSupport: true, recordTicket: true, escalate: false, pingHelpers: true, expertiseRouting: true },
  },
  {
    name: "helper pings off: everything else stays",
    patch: { helperPings: false },
    want: { createOnSupport: true, recordTicket: true, escalate: true, pingHelpers: false, expertiseRouting: true },
  },
  {
    name: "expertise routing off: plain workload selection, everything else stays",
    patch: { expertiseRouting: false },
    want: { createOnSupport: true, recordTicket: true, escalate: true, pingHelpers: true, expertiseRouting: false },
  },
];

for (const c of HELP_CASES) {
  test(`help role: ${c.name}`, () => {
    assert.deepEqual(ticketPolicy({ program: helpProg(c.patch), role: "help" }), c.want);
  });
}

const MAIN_CASES = [
  {
    name: "main all on",
    patch: {},
    want: { createOnSupport: true, recordTicket: true, escalate: true, pingHelpers: true, expertiseRouting: false },
  },
  {
    name: "main tickets off kills everything",
    patch: { ticketsEnabled: false },
    want: { createOnSupport: false, recordTicket: false, escalate: false, pingHelpers: false, expertiseRouting: false },
  },
  {
    name: "main escalation off: ticket recorded, never escalated or pinged",
    patch: { helperEscalationEnabled: false },
    want: { createOnSupport: true, recordTicket: true, escalate: false, pingHelpers: false, expertiseRouting: false },
  },
  {
    name: "main enabled off kills everything",
    patch: { enabled: false },
    want: { createOnSupport: false, recordTicket: false, escalate: false, pingHelpers: false, expertiseRouting: false },
  },
];

for (const c of MAIN_CASES) {
  test(`main role: ${c.name}`, () => {
    assert.deepEqual(ticketPolicy({ program: mainProg(c.patch), role: "main" }), c.want);
  });
}

test("main role defaults deny (both flags default OFF)", () => {
  const bare = { id: "pol-bare", posture: "active", helpChannel: "C-b", channels: ["C-b"] };
  assert.deepEqual(ticketPolicy({ program: bare, role: "main" }), {
    createOnSupport: false,
    recordTicket: false,
    escalate: false,
    pingHelpers: false,
    expertiseRouting: false,
  });
});

test("legacy flags derive the same policy (no stored behavior)", () => {
  const noPing = { id: "pol-leg", posture: "active", helpChannel: "C-l", channels: ["C-l"] };
  assert.deepEqual(ticketPolicy({ program: noPing, role: "help" }), {
    createOnSupport: true,
    recordTicket: true,
    escalate: true,
    pingHelpers: false,
    expertiseRouting: true,
  });
  const optIn = { ...noPing, helperPing: true };
  assert.equal(ticketPolicy({ program: optIn, role: "help" }).pingHelpers, true);
  const noTickets = { ...noPing, ticketsEnabled: false };
  assert.deepEqual(ticketPolicy({ program: noTickets, role: "help" }), {
    createOnSupport: false,
    recordTicket: false,
    escalate: false,
    pingHelpers: false,
    expertiseRouting: true,
  });
  assert.equal(ticketPolicy({ program: { ...noTickets, helperPing: true }, role: "help" }).pingHelpers, true);
});

test("stored behavior overrides legacy flags", () => {
  const prog = {
    id: "pol-over",
    posture: "active",
    helpChannel: "C-o",
    channels: ["C-o"],
    ticketsEnabled: false, // legacy says off...
    behavior: { help: { ticketsEnabled: true } }, // ...settings say on
  };
  assert.equal(ticketPolicy({ program: prog, role: "help" }).recordTicket, true);
});

test("unknown program and non-support roles fail closed", () => {
  const deny = { createOnSupport: false, recordTicket: false, escalate: false, pingHelpers: false, expertiseRouting: false };
  assert.deepEqual(ticketPolicy({ program: null, role: "help" }), deny);
  assert.deepEqual(ticketPolicy({ role: "help" }), deny);
  assert.deepEqual(ticketPolicy({ program: helpProg(), role: "dm" }), deny);
  assert.deepEqual(ticketPolicy({ program: helpProg(), role: "none" }), deny);
  assert.deepEqual(ticketPolicy({ program: helpProg(), role: "bogus" }), deny);
});

test("resolveTicketRole: explicit role wins, program shape is the fallback", () => {
  const prog = { id: "p", helpChannel: "C-help", channels: ["C-main"] };
  assert.equal(resolveTicketRole({ program: prog, channel: "C-main", role: "help" }), "help");
  assert.equal(resolveTicketRole({ program: prog, channel: "C-help" }), "help");
  assert.equal(resolveTicketRole({ program: prog, channel: "C-main" }), "main");
  assert.equal(resolveTicketRole({ program: prog, channel: "C-unknown" }), "help");
  assert.equal(resolveTicketRole({ program: prog }), "help");
  assert.equal(resolveTicketRole({ channel: "C-unknown" }), "none");
  assert.equal(resolveTicketRole({}), "none");
});
export {};
