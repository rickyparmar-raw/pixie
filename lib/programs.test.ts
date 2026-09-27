type TestAny = any;
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");

db.open(":memory:");


test("scope defaults to any, so an existing program keeps answering everything", () => {
  programs.saveProgram({ id: "t-open", name: "Open Program" });
  assert.equal(programs.scope("t-open"), "any");
  assert.equal(programs.isProgramScoped(programs.get("t-open")), false);
});

test("scope survives a round trip through the database", () => {
  programs.saveProgram({ id: "t-scoped", name: "Scoped Program", scope: "program" });
  programs.invalidate();

  const loaded = programs.get("t-scoped");
  assert.equal(loaded.scope, "program");
  assert.equal(programs.scope("t-scoped"), "program");
  assert.equal(programs.isProgramScoped(loaded), true);
  assert.equal(programs.isProgramScoped("t-scoped"), true);
});

test("scope can be flipped back without a redeploy", () => {
  programs.saveProgram({ id: "t-flip", name: "Flip", scope: "program" });
  assert.equal(programs.scope("t-flip"), "program");

  programs.saveProgram({ ...programs.get("t-flip"), scope: "any" });
  assert.equal(programs.scope("t-flip"), "any");
});


test("an unrecognised scope value falls back to any", () => {
  programs.saveProgram({ id: "t-typo", name: "Typo", scope: "programme" });
  programs.invalidate();
  assert.equal(programs.scope("t-typo"), "any");
});

test("the shared YSWS program is never scoped", () => {
  assert.equal(programs.shared().scope, "any");
  assert.equal(programs.isProgramScoped(programs.shared()), false);
  assert.equal(programs.scope(null), "any");
});


function withEnvPrograms(value: TestAny, fn: TestAny) {
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  if (value === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = value;
  programs.invalidate();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
}

test("PIXIE_PROGRAMS_JSON supplies programs without any file on disk", () => {
  withEnvPrograms(
    JSON.stringify([
      {
        id: "solvable",
        name: "Solvable",
        helpChannel: "C0SOLVE",
        channels: ["C0SOLVE", "C0CHAT"],
        scope: "program",
        posture: "passive",
        sources: [{ name: "Solvable Docs", type: "url", url: "https://solvable.hackclub.com/docs" }],
      },
    ]),
    () => {
      const p = programs.get("solvable");
      assert.equal(p.name, "Solvable");
      assert.equal(p.helpChannel, "C0SOLVE");
      assert.equal(p.scope, "program");
      assert.equal(p.posture, "passive");
      assert.equal(p.sources[0].url, "https://solvable.hackclub.com/docs");
      assert.equal(programs.forChannel("C0CHAT").id, "solvable");
      assert.equal(programs.isHelpChannel("C0SOLVE"), true);
    },
  );
});

test("AI answers default on and honor the legacy snake_case field", () => {
  withEnvPrograms(JSON.stringify([
    { id: "answers-default", name: "Default" },
    { id: "answers-off-legacy", name: "Legacy", ai_answers: false },
  ]), () => {
    assert.equal(programs.get("answers-default").aiAnswers, true);
    assert.equal(programs.get("answers-off-legacy").aiAnswers, false);
    assert.equal(programs.aiAnswersEnabled("answers-default"), true);
    assert.equal(programs.aiAnswersEnabled("answers-off-legacy"), false);
  });
});


test("PIXIE_PROGRAMS_JSON wins over the repo's programs.json", () => {
  withEnvPrograms(JSON.stringify([{ id: "solvable", name: "Solvable", channels: ["C0SOLVE"] }]), () => {
    const ids = programs.all().map((p: TestAny) => p.id);
    assert.ok(ids.includes("solvable"));
    assert.ok(!ids.includes("pixl"), "the image's own program must not leak into a fleet bot");
  });
});


test("PIXIE_PROGRAMS_JSON accepts the wrapped object form", () => {
  withEnvPrograms(JSON.stringify({ programs: [{ id: "twisted", name: "Twisted" }] }), () => {
    assert.equal(programs.get("twisted").name, "Twisted");
  });
});

test("Hardwire defaults to an isolated corpus when sync omits sharedSources", () => {
  withEnvPrograms(JSON.stringify([{ id: "hardwire", name: "Hardwire", scope: "program" }]), () => {
    assert.equal(programs.get("hardwire").sharedSources, false);
  });
});


test("malformed PIXIE_PROGRAMS_JSON falls back to files instead of throwing", () => {
  withEnvPrograms('[{"id":"solvable"', () => {
    const ids = programs.all().map((p: TestAny) => p.id);
    assert.ok(ids.length > 0);
    assert.ok(!ids.includes("solvable"));
  });
});

test("PIXIE_PROGRAMS_JSON of the wrong type falls back to files", () => {
  withEnvPrograms(JSON.stringify({ solvable: { name: "Solvable" } }), () => {
    assert.ok(!programs.all().some((p: TestAny) => p.id === "solvable"));
  });
});


test("PIXIE_PROGRAMS_JSON drops records with no id", () => {
  withEnvPrograms(JSON.stringify([{ name: "Nameless" }, { id: "real", name: "Real" }]), () => {
    const ids = programs.all().map((p: TestAny) => p.id);
    assert.deepEqual(ids.filter((id: TestAny) => id === "real"), ["real"]);
    assert.ok(!ids.includes(undefined));
  });
});


test("a ysws-global entry in PIXIE_PROGRAMS_JSON overrides the shared sources", () => {
  withEnvPrograms(
    JSON.stringify([
      { id: "ysws-global", name: "Shared", sources: [{ name: "My FAQ", type: "json-faq", content: [] }] },
    ]),
    () => {
      const sharedProg = programs.shared();
      assert.equal(sharedProg.sources.length, 1);
      assert.equal(sharedProg.sources[0].name, "My FAQ");
      assert.equal(sharedProg.scope, "any", "shared stays unscoped whatever the blob says");
    },
  );
});

test("with no PIXIE_PROGRAMS_JSON the shared program still comes from sources.json", () => {
  withEnvPrograms(undefined, () => {
    assert.equal(programs.shared().id, "ysws-global");
    assert.equal(programs.shared().name, "YSWS Global");
  });
});

test("Twisted is program-scoped and does not inherit shared program facts", () => {
  withEnvPrograms(undefined, () => {
    const twisted = programs.get("twisted");
    assert.equal(twisted.scope, "program");
    assert.equal(twisted.sharedSources, false);
    assert.ok(twisted.sources.some((source: TestAny) => source.url === "file://./twisted-faq.json"));
    assert.ok(twisted.pinnedRules.some((rule: TestAny) => /program_id=twisted/.test(rule)));
    assert.ok(!twisted.sources.some((source: TestAny) => source.url === "file://./quick-links.json"));
  });
});


test("a fleet bot gets an empty shared layer rather than Pixl's quick links", () => {
  withEnvPrograms(JSON.stringify([{ id: "solvable", name: "Solvable" }]), () => {
    const sharedProg = programs.shared();
    assert.deepEqual(sharedProg.sources, []);
    assert.deepEqual(sharedProg.milestones, []);
    assert.equal(sharedProg.scope, "any");
    assert.deepEqual(sharedProg.guides, ["submit-ysws-guidelines"]);
  });
});


test("the shared program stays unscoped even if the blob says otherwise", () => {
  withEnvPrograms(JSON.stringify([{ id: "ysws-global", name: "Shared", scope: "program" }]), () => {
    assert.equal(programs.shared().scope, "any");
  });
});


test("char: forChannel prefers an explicit workspace-scoped claim over config lists", () => {
  withEnvPrograms(undefined, () => {
    programs.saveProgram({ id: "char-a", name: "A", helpChannel: "C-CHAR-A", channels: ["C-CHAR-A"] });
    programs.saveProgram({ id: "char-b", name: "B", helpChannel: "C-CHAR-B", channels: ["C-CHAR-B"] });
    programs.invalidate();
    db.claimProgramChannel({ workspaceId: "T-CHAR", channelId: "C-CHAR-A", programId: "char-b", kind: "help" });
    try {
      assert.equal(programs.forChannel("C-CHAR-A", "T-CHAR").id, "char-b");
      assert.equal(programs.forChannel("C-CHAR-A", "T-OTHER").id, "char-a");
    } finally {
      db.releaseProgramChannel({ workspaceId: "T-CHAR", channelId: "C-CHAR-A" });
    }
  });
});

test("char: forChannel with no channel falls back to shared, never another program", () => {
  withEnvPrograms(undefined, () => {
    assert.equal(programs.forChannel(null).id, "ysws-global");
    assert.equal(programs.forChannel(undefined).id, "ysws-global");
  });
});

test("char: channel claims are atomic — second program loses, same-program retry wins", () => {
  const first = db.claimProgramChannel({ workspaceId: "T-CHAR-AT", channelId: "C-CHAR-AT", programId: "char-a", kind: "help" });
  assert.equal(first.ok, true);
  const conflict = db.claimProgramChannel({ workspaceId: "T-CHAR-AT", channelId: "C-CHAR-AT", programId: "char-b", kind: "help" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ownerProgramId, "char-a");
  const retry = db.claimProgramChannel({ workspaceId: "T-CHAR-AT", channelId: "C-CHAR-AT", programId: "char-a", kind: "help" });
  assert.equal(retry.ok, true);
  db.releaseProgramChannel({ workspaceId: "T-CHAR-AT", channelId: "C-CHAR-AT" });
});

test("char: same channel id in another workspace is a different claim", () => {
  db.claimProgramChannel({ workspaceId: "T-CHAR-W1", channelId: "C-CHAR-WS", programId: "char-a", kind: "help" });
  try {
    const other = db.claimProgramChannel({ workspaceId: "T-CHAR-W2", channelId: "C-CHAR-WS", programId: "char-b", kind: "help" });
    assert.equal(other.ok, true);
  } finally {
    db.releaseProgramChannel({ workspaceId: "T-CHAR-W1", channelId: "C-CHAR-WS" });
    db.releaseProgramChannel({ workspaceId: "T-CHAR-W2", channelId: "C-CHAR-WS" });
  }
});

test("char: normalize preserves the uncommitted incident/public-ticket fields", () => {
  withEnvPrograms(
    JSON.stringify([
      { id: "char-inc", name: "Inc", incidentMode: "TRACK_ONLY", publicTicketsEnabled: false },
      { id: "char-inc2", name: "Inc2", incident_mode: "ANSWER_AND_TRACK", public_tickets_enabled: 0 },
    ]),
    () => {
      assert.equal(programs.get("char-inc").incidentMode, "TRACK_ONLY");
      assert.equal(programs.get("char-inc").publicTicketsEnabled, false);
      assert.equal(programs.get("char-inc2").incidentMode, "ANSWER_AND_TRACK");
      assert.equal(programs.get("char-inc2").publicTicketsEnabled, false);
    },
  );
});

test("char: normalize defaults incident/public-ticket fields when absent", () => {
  withEnvPrograms(JSON.stringify([{ id: "char-def", name: "Def" }]), () => {
    assert.equal(programs.get("char-def").incidentMode, "ANSWER_AND_TRACK");
    assert.equal(programs.get("char-def").publicTicketsEnabled, true);
  });
});

test("char: isHelpChannel is workspace-scoped for claims", () => {
  withEnvPrograms(undefined, () => {
    programs.saveProgram({ id: "char-h", name: "H", helpChannel: "C-CHAR-H", channels: ["C-CHAR-H"] });
    programs.invalidate();
    db.claimProgramChannel({ workspaceId: "T-CHAR-H", channelId: "C-CHAR-H", programId: "char-h", kind: "help" });
    try {
      assert.equal(programs.isHelpChannel("C-CHAR-H", "T-CHAR-H"), true);
      assert.equal(programs.isHelpChannel("C-NOWHERE", "T-CHAR-H"), false);
      assert.equal(programs.isHelpChannel(null), false);
    } finally {
      db.releaseProgramChannel({ workspaceId: "T-CHAR-H", channelId: "C-CHAR-H" });
    }
  });
});
export {};
