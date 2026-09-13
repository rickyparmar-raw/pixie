// Differential trace pins: every stage of the support pipeline, recorded
// through the CURRENT production functions, for the contextual matrix
// inputs. A rewritten stage must reproduce its record entry exactly — the
// FIRST divergence, not just the final reply, is what these tests catch.
//
// Fixture programs mirror lib/contextualSupport.test.js (same ids, same
// inline docs) so the two suites describe one behavior from two angles:
// final disposition there, per-stage records here.
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const knowledge = require("./knowledge");
const programs = require("./programs");
const intent = require("./intent");
const { traceSupportRequest } = require("./supportTrace");

db.open(":memory:");

const HW_DOCS = `## Tiers
Hardwire has three tiers. Tier 1 is for first-time builders: blink an LED and write a short reflection. Tier 2 is the main build: design a custom PCB, get it fabricated, assemble it, and demo working firmware. Tier 3 is the stretch goal: add wireless connectivity and publish full documentation.`;

const PIXL_DOCS = `## Submission
To submit your Pixl project, push your code to GitHub, record a demo video, and fill out the submission form before the deadline.`;

const OTHER_DOCS = `## Mascot
The Other program's mascot is a purple platypus named Plax.`;

function helpNeeded() {
  return {
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    directedAtHuman: false,
    recentPixieParticipation: false,
    programRelevance: "relevant",
  };
}

function at(trace, name) {
  const entry = trace.find((e) => e.stage === name);
  assert.ok(entry, `missing stage: ${name}`);
  return entry;
}

before(async () => {
  programs.saveProgram({ id: "ctx-hw", name: "Hardwire", sharedSources: false, helpChannel: "C-HW-HELP", channels: ["C-HW"], sources: [{ name: "Hardwire Docs", type: "text", content: HW_DOCS }] });
  programs.saveProgram({ id: "ctx-pixl", name: "Pixl", sharedSources: false, helpChannel: "C-PIXL-HELP", channels: ["C-PIXL"], sources: [{ name: "Pixl Docs", type: "text", content: PIXL_DOCS }] });
  programs.saveProgram({ id: "ctx-other", name: "Other", sharedSources: false, helpChannel: "C-OTHER-HELP", channels: ["C-OTHER"], sources: [{ name: "Other Docs", type: "text", content: OTHER_DOCS }] });
  programs.invalidate();
  for (const src of [
    { name: "Hardwire Docs", type: "text", content: HW_DOCS },
    { name: "Pixl Docs", type: "text", content: PIXL_DOCS },
    { name: "Other Docs", type: "text", content: OTHER_DOCS },
  ]) {
    await knowledge.refreshSource(src, true);
  }
  knowledge.invalidate();
});

test("trace records every stage in order for a tier question", () => {
  const { programId, trace } = traceSupportRequest({
    channel: "C-HW",
    threadTs: "trace-t-1",
    userId: "trace-u-1",
    question: "what are tiers, explain them",
    intentVerdict: helpNeeded(),
    candidate: { source: "Hardwire Docs", answer: "three tiers" },
  });
  assert.deepEqual(trace.map((e) => e.stage), [
    "program-resolution",
    "channel-classification",
    "eligibility",
    "thread-context",
    "retrieval-query",
    "retrieval-results",
    "source-freshness",
    "intent",
    "grounding",
    "final-disposition",
    "slack-effects",
  ]);
  assert.equal(programId, "ctx-hw");
  assert.equal(at(trace, "final-disposition").output, "REPLY");
  assert.deepEqual(at(trace, "slack-effects").output, [{ kind: "slack.post", channel: "C-HW", threadTs: "trace-t-1", textChars: 11 }]);
});

test("program resolution + retrieval stay scoped at every stage", () => {
  const { trace } = traceSupportRequest({
    channel: "C-HW",
    threadTs: "trace-t-2",
    userId: "trace-u-2",
    question: "what are tiers, explain them",
    intentVerdict: helpNeeded(),
    candidate: { source: "Hardwire Docs", answer: "three tiers" },
  });
  assert.equal(at(trace, "program-resolution").output.id, "ctx-hw");
  assert.match(JSON.stringify(at(trace, "retrieval-results").output), /Hardwire Docs/);
  const results = JSON.stringify(at(trace, "retrieval-results").output);
  assert.doesNotMatch(results, /Pixl Docs|Other Docs/);
  const freshnessNames = at(trace, "source-freshness").output.map((s) => s.name);
  assert.ok(freshnessNames.includes("Hardwire Docs"));
  assert.ok(!freshnessNames.includes("Pixl Docs") && !freshnessNames.includes("Other Docs"));
});

test("failed intent silences before retrieval evidence matters", () => {
  const { trace } = traceSupportRequest({
    channel: "C-HW",
    threadTs: "trace-t-3",
    userId: "trace-u-3",
    question: "what are tiers, explain them",
    intentVerdict: null,
    candidate: { source: "Hardwire Docs", answer: "three tiers" },
  });
  assert.equal(at(trace, "intent").output, null);
  assert.equal(at(trace, "final-disposition").output, "SILENCE");
  assert.deepEqual(at(trace, "slack-effects").output, []);
});

test("insufficient evidence escalates in help channels, silences elsewhere", () => {
  const help = traceSupportRequest({
    channel: "C-HW-HELP",
    threadTs: "trace-t-4",
    userId: "trace-u-4",
    question: "what is the Other mascot?",
    intentVerdict: helpNeeded(),
    candidate: null,
  });
  assert.equal(at(help.trace, "final-disposition").output, "ESCALATE");
  assert.deepEqual(at(help.trace, "slack-effects").output, [{ kind: "ticket.ensure", channel: "C-HW-HELP", threadTs: "trace-t-4" }]);

  const plain = traceSupportRequest({
    channel: "C-HW",
    threadTs: "trace-t-5",
    userId: "trace-u-5",
    question: "what is the Other mascot?",
    intentVerdict: helpNeeded(),
    candidate: null,
  });
  assert.equal(at(plain.trace, "final-disposition").output, "SILENCE");
});

test("grounding records source decisions without leaking other programs", () => {
  const { trace } = traceSupportRequest({
    channel: "C-PIXL",
    threadTs: "trace-t-6",
    userId: "trace-u-6",
    question: "how do i submit?",
    intentVerdict: helpNeeded(),
    candidate: { source: "Pixl Docs", answer: "fill the form" },
  });
  assert.equal(at(trace, "program-resolution").output.id, "ctx-pixl");
  assert.deepEqual(at(trace, "grounding").output, { source: "Pixl Docs", answerChars: 13 });
  assert.equal(at(trace, "final-disposition").output, "REPLY");
});
