process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const workspace = require("./workspace");
const routing = require("./routing");
const programs = require("./programs");

before(() => {
  db.close();
  db.open(":memory:");
});

test("workspaceOf prefers the event team id, then the configured one", () => {
  assert.equal(workspace.workspaceOf({ team: "T1", channel: "C1" }), "T1");
  assert.equal(workspace.workspaceOf({}, { team_id: "T2" }), "T2");
  assert.equal(workspace.workspaceOf({}), workspace.configuredWorkspaceId());
});

test("channel claims are atomic: second program loses, double claim wins", () => {
  const a = db.claimProgramChannel({ workspaceId: "T1", channelId: "C-help", programId: "highway", kind: "help" });
  assert.equal(a.ok, true);

  const conflict = db.claimProgramChannel({ workspaceId: "T1", channelId: "C-help", programId: "pixl", kind: "help" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ownerProgramId, "highway");

  // Same workspace+channel in another workspace is a different channel.
  const other = db.claimProgramChannel({ workspaceId: "T2", channelId: "C-help", programId: "pixl", kind: "help" });
  assert.equal(other.ok, true);

  // Double-submit Activate collapses onto the existing row.
  const retry = db.claimProgramChannel({ workspaceId: "T1", channelId: "C-help", programId: "highway", kind: "help" });
  assert.equal(retry.ok, true);
});

test("claimChannelsForProgram rolls back partial claims on conflict", () => {
  db.claimProgramChannel({ workspaceId: "T9", channelId: "C-taken", programId: "other", kind: "help" });
  const res = routing.claimChannelsForProgram({
    workspaceId: "T9",
    programId: "newprog",
    channels: [{ id: "C-free", kind: "help" }, { id: "C-taken", kind: "discussion" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.conflictChannel, "C-taken");
  assert.equal(db.getChannelOwner("T9", "C-free"), null);
});

test("forChannel resolves explicit claims before config lists", () => {
  programs.invalidate();
  db.saveProgram({ id: "hwy", name: "Highway", helpChannel: "C-hwy", channels: ["C-hwy"] });
  db.claimProgramChannel({ workspaceId: "TW", channelId: "C-hwy", programId: "hwy", kind: "help" });
  programs.invalidate();
  const prog = routing.resolveChannelProgram({ workspaceId: "TW", channelId: "C-hwy" });
  assert.equal(prog.id, "hwy");
  assert.equal(programs.isHelpChannel("C-hwy", "TW"), true);
});
