const { test } = require("node:test");
const assert = require("node:assert/strict");
const workspace = require("./workspace");

test("char: workspaceOf prefers event team, then body, then configured", () => {
  assert.equal(workspace.workspaceOf({ team: "T1" }, { team_id: "T2" }), "T1");
  assert.equal(workspace.workspaceOf({}, { team_id: "T2" }), "T2");
  assert.equal(workspace.workspaceOf({}, { team: { id: "T3" } }), "T3");
  assert.equal(workspace.workspaceOf({}), workspace.configuredWorkspaceId());
  assert.equal(workspace.workspaceOf(), workspace.configuredWorkspaceId());
});

test("char: threadKey scopes by workspace with a stable default", () => {
  assert.equal(workspace.threadKey("T1", "1.2"), "T1:1.2");
  assert.equal(workspace.threadKey(null, "1.2"), "default:1.2");
  assert.equal(workspace.threadKey(undefined, "1.2"), "default:1.2");
  assert.notEqual(workspace.threadKey("T1", "1.2"), workspace.threadKey("T2", "1.2"));
});

test("char: channelKey scopes by workspace with a stable default", () => {
  assert.equal(workspace.channelKey("T1", "C1"), "T1:C1");
  assert.equal(workspace.channelKey(null, "C1"), "default:C1");
  assert.notEqual(workspace.channelKey("T1", "C1"), workspace.channelKey("T1", "C2"));
  assert.notEqual(workspace.channelKey("T1", "C1"), workspace.channelKey("T2", "C1"));
});

test("char: configuredWorkspaceId trims and nulls when unset", () => {
  const saved = process.env.PIXIE_WORKSPACE_ID;
  try {
    process.env.PIXIE_WORKSPACE_ID = "  T9  ";
    assert.equal(workspace.configuredWorkspaceId(), "T9");
    delete process.env.PIXIE_WORKSPACE_ID;
    assert.equal(workspace.configuredWorkspaceId(), null);
    process.env.PIXIE_WORKSPACE_ID = "   ";
    assert.equal(workspace.configuredWorkspaceId(), null);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_WORKSPACE_ID;
    else process.env.PIXIE_WORKSPACE_ID = saved;
  }
});
export {};
