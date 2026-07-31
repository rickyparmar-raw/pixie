process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const llm = require("./llm");
const { config } = require("./config");
const report = require("./report");

db.open(":memory:");

// Every test drives the judge, so the model is stubbed throughout — otherwise
// the suite would spend a real call per gap.
async function withJudge(reply, fn) {
  const original = llm.complete;
  const asked = [];
  llm.complete = async (options) => {
    const question = options.messages.at(-1).content;
    asked.push(question);
    if (typeof reply === "function") return { text: await reply(question) };
    return { text: reply };
  };
  try {
    return await fn(asked);
  } finally {
    llm.complete = original;
  }
}

/* ----------------------------------------------------------------- judge -- */

test("judgeGap maps each verdict, however the model pads it", async () => {
  await withJudge("DOCS", async () => assert.equal(await report.judgeGap("who are pixl orgs"), report.DOCS));
  await withJudge("transient\n", async () => assert.equal(await report.judgeGap("is the site down"), report.TRANSIENT));
  await withJudge("NOISE.", async () => assert.equal(await report.judgeGap("marketing as in?"), report.NOISE));
});

// Fails closed like the capture judge: an unreadable verdict leaves the row
// unjudged, which keeps it OUT of the to-do list rather than guessing it in.
test("judgeGap returns null when the model says something unusable", async () => {
  await withJudge("i think probably yes?", async () => assert.equal(await report.judgeGap("anything"), null));
  await withJudge("", async () => assert.equal(await report.judgeGap("anything"), null));
});

test("judgeGap returns null when the call throws", async () => {
  const original = llm.complete;
  llm.complete = async () => {
    throw new Error("model on fire");
  };
  try {
    assert.equal(await report.judgeGap("anything"), null);
  } finally {
    llm.complete = original;
  }
});

test("the judge uses the cheap classifier model, not the answer model", async () => {
  const original = llm.complete;
  let used = null;
  llm.complete = async (options) => {
    used = options.model;
    return { text: "DOCS" };
  };
  try {
    await report.judgeGap("anything");
    assert.equal(used, config.intent.model);
  } finally {
    llm.complete = original;
  }
});

/* ------------------------------------------------------------- classify -- */

test("classifyGaps writes a verdict per gap and leaves unreadable ones alone", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.recordGap("who are pixl orgs", "U1", "C1");
  db.recordGap("and my pc crashed -_-", "U2", "C1");
  db.recordGap("even sp[aces failed me", "U3", "C1");

  const verdicts = {
    "who are pixl orgs": "DOCS",
    "and my pc crashed -_-": "TRANSIENT",
    "even sp[aces failed me": "???",
  };

  await withJudge((q) => verdicts[q], async () => {
    assert.equal(await report.classifyGaps({ limit: 10, spacingMs: 0 }), 2);
  });

  const counts = db.gapCountsByKind();
  assert.equal(counts[report.DOCS], 1);
  assert.equal(counts[report.TRANSIENT], 1);
  assert.equal(counts.unjudged, 1, "an unreadable verdict stays unjudged, not guessed");
});

test("classifyGaps stops at the per-pass cap and skips already-judged rows", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  for (let i = 0; i < 5; i++) db.recordGap(`question ${i}`, "U1", "C1");

  await withJudge("DOCS", async (asked) => {
    assert.equal(await report.classifyGaps({ limit: 2, spacingMs: 0 }), 2);
    assert.equal(asked.length, 2, "the cap is a cap");

    await report.classifyGaps({ limit: 10, spacingMs: 0 });
    assert.equal(asked.length, 5, "the three remaining are picked up, the two done are not re-judged");
  });
});

test("classifyGaps is a no-op with nothing pending", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  await withJudge("DOCS", async (asked) => {
    assert.equal(await report.classifyGaps({ limit: 5, spacingMs: 0 }), 0);
    assert.deepEqual(asked, []);
  });
});

/* ---------------------------------------------------------------- report -- */

// Seeds a gap already carrying its verdict, at a chosen age.
function seedGap(question, kind, agoMs = 0) {
  db.recordGap(question, "U1", "C1");
  const id = db.handle().query("SELECT MAX(id) AS id FROM doc_gaps").get().id;
  db.handle().query("UPDATE doc_gaps SET kind = ?, created_at = ? WHERE id = ?").run(kind, Date.now() - agoMs, id);
}

function seedMetric(kind, agoMs = 0) {
  db.recordMetric(kind, 1000);
  const id = db.handle().query("SELECT MAX(id) AS id FROM metrics").get().id;
  db.handle().query("UPDATE metrics SET created_at = ? WHERE id = ?").run(Date.now() - agoMs, id);
}

test("the report lists docs gaps and never the ones that aren't docs problems", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();

  seedGap("who are pixl orgs", report.DOCS);
  seedGap("who are pixl orgs", report.DOCS);
  seedGap("how do i be an org", report.DOCS);
  seedGap("is the pixl server down", report.TRANSIENT);
  seedGap("my pfp is bugged sometimes", report.TRANSIENT);
  seedGap("even sp[aces failed me", report.NOISE);
  seedMetric("answer_docs");
  seedMetric("answer_chat");

  const text = report.reportText(0);

  assert.match(text, /who are pixl orgs/);
  assert.match(text, /how do i be an org/);
  assert.match(text, /2×/, "identical asks are grouped and counted");

  assert.doesNotMatch(text, /server down/, "a transient problem is not a docs gap");
  assert.doesNotMatch(text, /pfp is bugged/);
  assert.doesNotMatch(text, /sp\[aces/);
  // But it says how many it kept out, so the filter is visible.
  assert.match(text, /\*3\* were one-off problems or chatter/);
});

test("the report shows the week-on-week change in coverage", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();

  // Last week: 1 of 4 from the docs (25%). This week: 3 of 4 (75%).
  const lastWeek = 10 * 24 * 60 * 60 * 1000;
  seedMetric("answer_docs", lastWeek);
  for (let i = 0; i < 3; i++) seedMetric("answer_chat", lastWeek);
  for (let i = 0; i < 3; i++) seedMetric("answer_docs");
  seedMetric("answer_chat");

  assert.match(report.reportText(0), /\*75%\* straight from the docs \(\+50 vs the week before\)/);
});

test("the report says so plainly when nothing was asked", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();
  assert.match(report.reportText(0), /nobody asked pixie anything this week/);
});

test("an unjudged backlog is reported as unsorted rather than silently dropped", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();
  seedMetric("answer_docs");
  db.recordGap("not judged yet", "U1", "C1");

  assert.match(report.reportText(0), /\*1\* not sorted yet/);
});

/* -------------------------------------------------------------- schedule -- */

test("lastBoundary lands on the most recent Monday 09:00", () => {
  // Wednesday 2026-07-29, 14:30 local -> Monday 2026-07-27 09:00.
  const boundary = new Date(report.lastBoundary(new Date(2026, 6, 29, 14, 30)));
  assert.equal(boundary.getDay(), 1);
  assert.equal(boundary.getHours(), 9);
  assert.equal(boundary.getDate(), 27);
});

// Monday before 09:00 belongs to the previous week's report, not this one.
test("lastBoundary rolls back a week when the boundary hasn't passed yet", () => {
  const boundary = new Date(report.lastBoundary(new Date(2026, 6, 27, 8, 0)));
  assert.equal(boundary.getDate(), 20);
  assert.equal(boundary.getHours(), 9);
});

test("a report is due once per week and not twice after a restart", async () => {
  db.handle().query("DELETE FROM metrics").run();
  // tick() classifies before it posts; an empty backlog keeps this test about
  // the schedule rather than about the judge.
  db.handle().query("DELETE FROM doc_gaps").run();
  assert.equal(report.isReportDue(), true, "never sent — due");

  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: "1" };
      },
    },
  };

  await report.postWeekly(client);
  assert.equal(posts.length, 1);
  assert.equal(report.isReportDue(), false, "just sent — not due again");

  // A restart re-reads the marker from SQLite rather than from memory.
  await report.tick(client);
  assert.equal(posts.length, 1, "a restart must not repost the same week");

  // Once the next boundary passes, it is due again.
  db.handle().query("UPDATE metrics SET created_at = ? WHERE kind = ?").run(Date.now() - 30 * 24 * 60 * 60 * 1000, report.SENT_METRIC);
  assert.equal(report.isReportDue(), true);
});

// A failed post must not mark the week as done, or the report is lost until the
// next one.
test("a post that throws leaves the report due", async () => {
  db.handle().query("DELETE FROM metrics").run();
  const client = {
    chat: {
      postMessage: async () => {
        throw new Error("slack said no");
      },
    },
  };

  await assert.rejects(() => report.postWeekly(client), /slack said no/);
  assert.equal(report.isReportDue(), true);
});

test("with no channel configured the weekly post is skipped, not attempted", async () => {
  const originalReport = config.reportChannel;
  const originalHelp = config.slack.helpChannel;
  config.reportChannel = null;
  config.slack.helpChannel = null;

  try {
    assert.equal(report.reportChannel(), null);
    assert.equal(await report.postWeekly({}), false, "no client call at all");
  } finally {
    config.reportChannel = originalReport;
    config.slack.helpChannel = originalHelp;
  }
});

// A first report has nothing to compare against; claiming a triumphant "+43"
// against a week of silence is an artefact, not a trend.
test("no trend is shown when the previous week has no data", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();
  seedMetric("answer_docs");
  seedMetric("answer_chat");

  const text = report.reportText(0);
  assert.match(text, /\*50%\* straight from the docs\./);
  assert.doesNotMatch(text, /vs the week before/);
  assert.doesNotMatch(text, /against 0 the week before/);
});
