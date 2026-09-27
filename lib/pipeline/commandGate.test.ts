// @ts-nocheck
// Commands are recognized and authorized before any conversational handling.
process.env.PIXIE_DB_PATH = ":memory:";
const { test, expect, beforeAll, afterAll, beforeEach } = require("bun:test");

const db = require("../db");
const programs = require("../programs");
const handlers = require("../handlers");
const respond = require("../respond");
const sumThread = require("../sumThread");

let savedEnv;
let savedRespond;
let savedSum;
let ephemerals;
let responds;
let sums;

function configure(behavior) {
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "pixl", name: "Pixl", helpChannel: "C_HELP", channels: ["C_HELP", "C_MAIN"], behavior },
  ]);
  programs.invalidate();
}

const client = {
  chat: {
    postEphemeral: async (m) => ephemerals.push(m),
    postMessage: async () => ({ ok: true, ts: "1" }),
    update: async () => ({ ok: true }),
    delete: async () => ({ ok: true }),
  },
  reactions: { add: async () => ({ ok: true }) },
  conversations: { replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
};

beforeAll(() => {
  savedEnv = process.env.PIXIE_PROGRAMS_JSON;
  db.open(":memory:");
  savedRespond = respond.respond;
  savedSum = sumThread.summarizeThreadForHelper;
});

afterAll(() => {
  respond.respond = savedRespond;
  sumThread.summarizeThreadForHelper = savedSum;
  if (savedEnv === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedEnv;
  programs.invalidate();
});

beforeEach(() => {
  ephemerals = [];
  responds = [];
  sums = [];
  respond.respond = async (args) => {
    responds.push(args);
    return false;
  };
  sumThread.summarizeThreadForHelper = async () => {
    sums.push(1);
    return "summary";
  };
});

let n = 0;
const event = (channel, text) => {
  n += 1;
  return { type: "message", channel, user: "U_RANDOM", text, ts: `${5000 + n}.1`, thread_ts: "4000.1" };
};

test("a normal user cannot run a helper command, and it never reaches classification", async () => {
  configure(null);
  await handlers.onMessage({ event: event("C_MAIN", "!sum"), client });
  expect(ephemerals).toHaveLength(1);
  expect(ephemerals[0].text).toMatch(/helpers-only/);
  expect(sums).toHaveLength(0);
  expect(responds).toHaveLength(0);
});

test("a program helper may run !sum, and it creates no ticket and no answer", async () => {
  configure(null);
  db.syncHelper({ programId: "pixl", userId: "U_RANDOM", role: "helper" });
  expect(db.isHelper("pixl", "U_RANDOM")).toBe(true);
  await handlers.onMessage({ event: event("C_MAIN", "!sum"), client });
  expect(sums).toHaveLength(1);
  expect(responds).toHaveLength(0);
});

test("main-channel commands switched off: refused with a clear reason, even for a helper", async () => {
  configure({ main: { commandsEnabled: false } });
  expect(db.isHelper("pixl", "U_RANDOM")).toBe(true);
  await handlers.onMessage({ event: event("C_MAIN", "!sum"), client });
  expect(ephemerals).toHaveLength(1);
  expect(sums).toHaveLength(0);
});
export {};
