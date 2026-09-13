process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPersistence } = require("./persistence");

const persistence = createPersistence();

before(() => {
  persistence.lifecycle.close();
  persistence.lifecycle.open(":memory:");
});

test("the persistence boundary preserves atomic message claims", () => {
  assert.equal(persistence.dedupe.claimMessage("p-1", "C1"), true);
  assert.equal(persistence.dedupe.claimMessage("p-1", "C2"), false);
  assert.equal(persistence.dedupe.wasAnswered("p-1"), true);
});

test("the persistence boundary preserves program and channel ownership", () => {
  persistence.programs.save({ id: "persist-a", name: "Persist A", workspaceId: "W-A" });
  persistence.programs.save({ id: "persist-b", name: "Persist B", workspaceId: "W-B" });
  assert.deepEqual(persistence.programs.claimChannel({ workspaceId: "W-A", channelId: "C-A", programId: "persist-a" }), { ok: true, programId: "persist-a" });
  assert.equal(persistence.programs.claimChannel({ workspaceId: "W-A", channelId: "C-A", programId: "persist-b" }).ok, false);
  assert.equal(persistence.programs.owner("W-A", "C-A").program_id, "persist-a");
  assert.equal(persistence.programs.owner("W-B", "C-A"), null);
});

test("the persistence boundary reopens a file without replacing durable state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-persistence-"));
  const filename = path.join(directory, "pixie.db");
  try {
    persistence.lifecycle.close();
    persistence.lifecycle.open(filename);
    persistence.dedupe.claimMessage("durable-1", "C-DURABLE");
    assert.equal(persistence.dedupe.wasAnswered("durable-1"), true);
    persistence.lifecycle.close();
    persistence.lifecycle.open(filename);
    assert.equal(persistence.dedupe.wasAnswered("durable-1"), true);
  } finally {
    persistence.lifecycle.close();
    fs.rmSync(directory, { recursive: true, force: true });
    persistence.lifecycle.open(":memory:");
  }
});

after(() => persistence.lifecycle.close());
