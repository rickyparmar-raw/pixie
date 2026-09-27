const { test } = require("node:test");
const assert = require("node:assert/strict");
const program = require("./program");

const NOW = new Date("2026-07-28T12:00:00Z");
const METADATA = { name: "Example", aliases: ["demo"] };
const MILESTONES = [{ name: "Example launch", date: "2026-08-18", questions: ["When does it go live?"] }];

test("describeWhen counts whole days in both directions", () => {
  assert.equal(program.describeWhen(new Date("2026-07-28T23:00:00Z"), NOW), "today");
  assert.equal(program.describeWhen(new Date("2026-07-29T01:00:00Z"), NOW), "tomorrow");
  assert.equal(program.describeWhen(new Date("2026-08-01T00:00:00Z"), NOW), "in 4 days");
  assert.equal(program.describeWhen(new Date("2026-07-20T00:00:00Z"), NOW), "8 days ago");
});

test("describeEntry includes status and optional notes", () => {
  assert.match(program.describeEntry({ name: "Launch", date: "2026-08-01", note: "official" }, NOW), /in 4 days/);
  assert.match(program.describeEntry({ name: "Kickoff", date: "2026-07-01" }, NOW), /already passed/);
  assert.equal(program.describeEntry({ name: "Bad", date: "not a date" }, NOW), null);
});

test("corpusSection sorts configured milestones and includes the date guardrail", () => {
  const section = program.corpusSection(
    NOW,
    { milestones: [MILESTONES[0], { name: "Earlier", date: "2026-07-01" }] },
    METADATA,
  );
  assert.ok(section.indexOf("Earlier") < section.indexOf("Example launch"));
  assert.match(section, /Today's date is July 28, 2026/);
  assert.match(section, /Never state a date or a countdown that is not listed here/);
});

test("timeline matching uses configured names and aliases", () => {
  assert.equal(program.isTimingQuestion("has demo launched", METADATA), true);
  assert.equal(program.isTimingQuestion("how do I join", METADATA), false);
  assert.equal(program.isTimingQuestion("where do you live", METADATA), false);
});

test("directAnswer resolves one configured milestone and changes tense after it passes", () => {
  const result = program.directAnswer("has demo launched", NOW, MILESTONES, METADATA);
  assert.deepEqual(result, {
    source: "Program timeline",
    answer: "not yet — Example launch is August 18, 2026, in 21 days.",
  });
  assert.match(
    program.directAnswer("has demo launched", new Date("2026-09-01T12:00:00Z"), MILESTONES, METADATA).answer,
    /was August 18/,
  );
});

test("ambiguous, malformed, or absent timeline data fails closed", () => {
  assert.equal(program.corpusSection(NOW, null, METADATA), "");
  assert.equal(program.directAnswer("has demo launched", NOW, null, METADATA), null);
  assert.equal(
    program.directAnswer(
      "when is the deadline",
      NOW,
      [...MILESTONES, { name: "Second milestone", date: "2026-09-30" }],
      METADATA,
    ),
    null,
  );
  assert.equal(program.isTimingQuestion("has launched", { name: null, aliases: [] }), false);
});

test("load returns null for a missing operator file", () => {
  assert.equal(program.load("/nonexistent/program.json"), null);
});

export {};
