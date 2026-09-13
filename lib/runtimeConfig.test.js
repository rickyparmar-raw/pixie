process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const runtimeConfig = require("./runtimeConfig");

before(() => {
  db.close();
  db.open(":memory:");
  programs.invalidate();
});

test("projects a normalized program without changing legacy precedence", () => {
  const projected = runtimeConfig.forProgram({
    id: "runtime-program",
    name: "Runtime Program",
    workspaceId: "workspace-a",
    posture: "passive",
    scope: "program",
    ticketsEnabled: false,
    autoEscalate: false,
    publicTicketsEnabled: false,
    incidentMode: "ANSWER_ONLY",
    shadowMode: true,
    autoAssign: true,
    channels: ["C1"],
  });
  assert.deepEqual(projected, {
    programId: "runtime-program",
    programName: "Runtime Program",
    supportName: null,
    supportIconUrl: null,
    posture: "passive",
    scope: "program",
    deploymentMode: "dedicated_legacy",
    aiAnswers: true,
    tickets: {
      enabled: false,
      autoEscalate: false,
      openReaction: null,
      resolvedReaction: null,
      requireHelper: false,
      publicEnabled: false,
      incidentMode: "ANSWER_ONLY",
    },
    shadowMode: true,
    autoAssign: true,
    requireGroundedAnswer: false,
    threadRequireMention: false,
    helpChannel: null,
    organizerChannel: null,
    channels: ["C1"],
    workspaceId: "workspace-a",
  });
});

test("forChannel delegates workspace-scoped resolution to programs.js", () => {
  db.saveProgram({ id: "runtime-a", name: "Runtime A", workspaceId: "W-A", channels: ["C-SHARED"] });
  db.saveProgram({ id: "runtime-b", name: "Runtime B", workspaceId: "W-B", channels: ["C-SHARED"] });
  programs.invalidate();
  assert.equal(runtimeConfig.forChannel("C-SHARED", "W-A").programId, "runtime-a");
  assert.equal(runtimeConfig.forChannel("C-SHARED", "W-B").programId, "runtime-b");
});

test("public projection contains no provider credentials", () => {
  const result = runtimeConfig.publicConfig(runtimeConfig.forProgram("ysws-global"));
  assert.equal("apiKey" in result, false);
  assert.equal("models" in result, false);
  assert.equal("botToken" in result.slack, false);
});

after(() => db.close());
