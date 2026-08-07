// The weekly report: what the docs should answer and don't, what was never a
// docs problem, and what went well.
//
// `/pixie-gaps` already listed every question pixie missed, but a miss is a much
// weaker claim than "the docs should cover this". The live table had an outage,
// somebody's broken laptop and a half-typed fragment sitting next to the real
// gaps, so the list read as noise and nobody worked through it. Everything here
// exists to make one short list that is actually worth acting on.
const db = require("./db");
const learn = require("./learn");
const { config } = require("./config");
// Module object rather than destructured, so the judge can be stubbed — see the
// note in lib/respond.js.
const llm = require("./llm");
const log = require("./log");
const { coverageStats, relativeTime } = require("./stats");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// One word out, same as the capture judge in lib/learn.js.
const JUDGE_MAX_TOKENS = 5;
const JUDGE_TIMEOUT_MS = 10000;

// Paced like lib/warm.js: this is unattended background work and must never be
// the reason a real question queues behind it on a free tier.
const JUDGE_PER_PASS = 5;
const JUDGE_SPACING_MS = 4000;
const JUDGE_CYCLE_MS = 10 * 60 * 1000;

const DOCS = "docs";
const TRANSIENT = "transient";
const NOISE = "noise";

const GAP_LIMIT = 10;
const PENDING_CAP = 100;
// Monday, 09:00 local — a to-do list lands better at the start of a week than
// at the end of one.
const REPORT_DAY = 1;
const REPORT_HOUR = 9;

const SENT_METRIC = "weekly_report";

let timer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------------------------------------------------------------- judge -- */

// The three verdicts, described by what they cost if you get them wrong. A
// transient issue promoted to a docs gap wastes someone's afternoon writing
// documentation for an outage; a real gap demoted to noise means the question
// keeps getting asked forever.
//
// The examples are lifted from the live table rather than invented, because
// those are the shapes that actually turn up.
function judgePrompt() {
  return [
    "Someone asked this in a Slack help channel for Pixl, a program where teenagers build and ship projects.",
    "Pixie, a docs bot, could not answer it. Decide what kind of gap it is.",
    "",
    `${DOCS} — a real question about Pixl or its tooling that the documentation SHOULD answer.`,
    '  Examples: "who are pixl orgs", "how do i be an org", "which marketplaces should i look for",',
    '            "how do i unlock the next region", "can i submit late".',
    "",
    `${TRANSIENT} — true when they asked, useless as documentation. An outage, a service being down,`,
    "  a temporary bug, or something wrong with this one person's machine, account or setup.",
    '  Examples: "is the site down rn", "my pfp is bugged sometimes", "and my pc crashed",',
    '            "im getting a 502", "is it just me or is it slow".',
    "",
    `${NOISE} — anything the Pixl documentation could not answer for anyone else. Fragments and`,
    "  half-typed messages, statements and opinions that aren't asking anything, thinking out loud,",
    "  chat about pixie itself, jokes, thanks, a message aimed at one specific person, or a question",
    "  about unrelated software and general trivia.",
    '  Examples: "even sp[aces failed me", "ridit isn\'t", "what should i add to pixie", "PIXOSTART",',
    '            "need to expand the docs", "what if i just used 60 api keys", "pixie say my name",',
    '            "marketing as in?", "what tht does", "what colour scheme is catppuccin".',
    "",
    `Reply with EXACTLY one word: ${DOCS}, ${TRANSIENT} or ${NOISE}.`,
    "",
    `Be strict. ${DOCS} is a to-do list somebody has to work through, so when in doubt choose`,
    `${TRANSIENT} or ${NOISE}. Only answer ${DOCS} if you could write a documentation section that`,
    "answers it, and that section would still be useful to a different person next month.",
    "A message that isn't asking a question is never DOCS, however much it mentions Pixl.",
  ].join("\n");
}

// Returns a verdict, or null when the call failed or came back unreadable.
// Null leaves the row unjudged, which keeps it OUT of the to-do list — the same
// fail-closed shape as the capture judge in lib/learn.js.
async function judgeGap(question) {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: JUDGE_MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: JUDGE_TIMEOUT_MS,
        messages: [
          { role: "system", content: judgePrompt() },
          { role: "user", content: question },
        ],
      },
      "report",
    );

    const verdict = (text || "").trim().toLowerCase();
    return [DOCS, TRANSIENT, NOISE].find((kind) => verdict.startsWith(kind)) || null;
  } catch (e) {
    log.debug("report", `gap judge failed: ${e.message}`);
    return null;
  }
}

// One pass over the unjudged backlog. Newest first, so today's questions are
// classified before three-week-old ones.
async function classifyGaps({ limit = JUDGE_PER_PASS, spacingMs = JUDGE_SPACING_MS } = {}) {
  const pending = db.unclassifiedGaps(limit);
  if (pending.length === 0) return 0;

  let judged = 0;
  for (const gap of pending) {
    const kind = await judgeGap(gap.question);
    if (kind) {
      db.setGapKind(gap.id, kind);
      judged += 1;
      log.debug("report", `gap #${gap.id} judged ${kind}: "${gap.question.slice(0, 50)}"`);
    }
    await sleep(spacingMs);
  }

  if (judged > 0) log.info("report", `judged ${judged} gap(s)`);
  return judged;
}

/* ---------------------------------------------------------------- draft -- */

// Drafting is generative, not classification, so it runs on the answer model
// rather than the cheap classifier one — a maintainer reviewing this deserves
// the same quality bar as a real reply.
const DRAFT_MAX_TOKENS = 400;
const DRAFT_TIMEOUT_MS = 15000;

// Same pacing shape as the gap judge above, for the same reason: unattended
// background work that must never queue behind a real question on a free tier.
const DRAFT_PER_PASS = 3;

// Marks a synthetic draft in learned_facts.source_ts so it can't be mistaken
// for a real Slack ts, while still riding that column's unique index — one
// draft per gap, ever, even across restarts.
const DRAFT_SOURCE_PREFIX = "gap-draft:";

// Same "when in doubt" posture as judgePrompt: a wrong or invented answer in
// the review queue does more damage than a missing one, since a maintainer
// reviews it with the same trust as a real captured answer.
function draftPrompt() {
  return [
    "Someone asked this in the Slack help channel for Pixl, a program where teenagers build and ship projects.",
    "The documentation doesn't cover it yet, and a maintainer decided it should.",
    "",
    "Write the documentation entry that answers it — direct and factual, the way a FAQ entry reads.",
    'Write only the answer itself: no restated question, no "Q:"/"A:" labels, no mention that this is a draft.',
    "",
    "If you don't actually know the answer, reply with EXACTLY: UNKNOWN. A missing draft costs nothing — a",
    "maintainer writes it instead. A confident, invented answer in the review queue costs someone's trust.",
  ].join("\n");
}

// Returns drafted doc text, or null when the call failed or the model didn't
// actually know the answer. Null leaves the gap undrafted — same fail-closed
// shape as judgeGap and learn.judgeAnswer.
async function draftDoc(question) {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.answer.baseUrl,
        apiKey: config.answer.apiKey,
        model: config.answer.model,
        fallback: config.answer.fallback,
        onRateLimited: config.answer.onRateLimited,
        maxTokens: DRAFT_MAX_TOKENS,
        temperature: 0.3,
        timeout: DRAFT_TIMEOUT_MS,
        messages: [
          { role: "system", content: draftPrompt() },
          { role: "user", content: question },
        ],
      },
      "report",
    );

    const trimmed = (text || "").trim();
    if (!trimmed || trimmed.toUpperCase().startsWith("UNKNOWN")) return null;
    return trimmed;
  } catch (e) {
    log.debug("report", `doc draft failed: ${e.message}`);
    return null;
  }
}

function draftSourceTs(gapId) {
  return `${DRAFT_SOURCE_PREFIX}${gapId}`;
}

// Turns this week's recurring DOCS gaps into review-queue candidates — the
// same PENDING row shape lib/learn.js already produces from a human reply, so
// the existing Home tab Approve/Drop buttons and corpusSection() need no
// changes to pick these up. topGaps groups by normalized question, so "how do
// i join" asked by five people drafts once, not five times.
async function draftGaps({ limit = DRAFT_PER_PASS, spacingMs = JUDGE_SPACING_MS, sinceMs = WEEK_MS } = {}) {
  const candidates = db
    .topGaps(GAP_LIMIT, sinceMs, { kind: DOCS })
    .filter((gap) => !db.hasCapturedSource(draftSourceTs(gap.id)))
    .slice(0, limit);
  if (candidates.length === 0) return 0;

  let drafted = 0;
  for (const gap of candidates) {
    const answer = await draftDoc(gap.question);
    if (answer) {
      const id = db.addLearnedFact({
        question: gap.question,
        answer,
        status: learn.PENDING,
        sourceTs: draftSourceTs(gap.id),
      });
      if (id) {
        drafted += 1;
        log.debug("report", `drafted a doc suggestion for gap #${gap.id}: "${gap.question.slice(0, 50)}"`);
      }
    }
    await sleep(spacingMs);
  }

  if (drafted > 0) log.info("report", `drafted ${drafted} doc suggestion(s)`);
  return drafted;
}

/* ---------------------------------------------------------------- report -- */

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

// Signed, so "coverage 41% (+18)" reads as movement rather than a bare number.
function delta(current, previous) {
  const diff = current - previous;
  if (diff === 0) return "no change";
  return `${diff > 0 ? "+" : ""}${diff}`;
}

function answeredFrom(counts) {
  const docs = counts.answer_docs || 0;
  const chat = counts.answer_chat || 0;
  const linked = counts.answer_link || 0;
  return { docs, chat, linked, total: docs + chat + linked };
}

// Everything the report needs, for one week-long window. `weeksAgo` of 1 gives
// the week before, which is where the trend comes from.
function collect(weeksAgo = 0) {
  const until = Date.now() - weeksAgo * WEEK_MS;
  const sinceMs = (weeksAgo + 1) * WEEK_MS;

  const counts = Object.fromEntries(db.metricCounts(sinceMs, until).map((r) => [r.kind, r.count]));
  const answered = answeredFrom(counts);

  return {
    until,
    counts,
    answered,
    coverage: pct(answered.docs, answered.total),
    gaps: db.topGaps(GAP_LIMIT, sinceMs, { kind: DOCS, untilMs: until }),
    gapKinds: db.gapCountsByKind(sinceMs, until),
  };
}

function reportLines(weeksAgo = 0) {
  const week = collect(weeksAgo);
  const previous = collect(weeksAgo + 1);
  const { known, instant, cacheHits } = coverageStats();

  const lines = [`*pixie weekly report* — ${weeksAgo === 0 ? "last 7 days" : `week ending ${relativeTime(week.until)}`}`];

  if (week.answered.total === 0) {
    lines.push("", "_nobody asked pixie anything this week._");
    return lines;
  }

  // A comparison against a week with no data isn't a trend, it's an artefact —
  // the first report would otherwise claim a triumphant "+43" against silence.
  const comparable = previous.answered.total > 0;
  const trend = comparable ? ` (${delta(week.coverage, previous.coverage)} vs the week before)` : "";

  lines.push(
    "",
    `*${week.answered.total}* questions answered — *${week.coverage}%* straight from the docs${trend}.`,
  );

  // The actionable part, first.
  lines.push("", "*the docs should answer these*");
  if (week.gaps.length === 0) {
    lines.push("_nothing outstanding_ :yay:");
  } else {
    for (const gap of week.gaps) {
      lines.push(`• *${gap.count}×* — ${gap.question.slice(0, 150)}`);
    }
  }

  // Everything the judge kept off that list, as one line — enough to see the
  // filter working, not enough to bury the list above.
  const filtered = (week.gapKinds[TRANSIENT] || 0) + (week.gapKinds[NOISE] || 0);
  const unjudged = week.gapKinds.unjudged || 0;
  if (filtered > 0 || unjudged > 0) {
    const parts = [];
    if (filtered > 0) parts.push(`*${filtered}* were one-off problems or chatter, not docs gaps`);
    if (unjudged > 0) parts.push(`*${unjudged}* not sorted yet`);
    lines.push("", `_${parts.join(", ")}._`);
  }

  lines.push("", "*what went well*");
  lines.push(
    `• answered *${week.answered.docs}* questions from the docs` +
      (comparable ? `, against ${previous.answered.docs} the week before` : ""),
  );
  lines.push(`• knows *${known}* answers cold — *${cacheHits}* replies (${instant}%) needed no thinking at all`);

  const votes = db.feedbackTotals();
  if ((votes.up || 0) + (votes.down || 0) > 0) {
    lines.push(`• feedback: *${votes.up || 0}* up / *${votes.down || 0}* down`);
  }

  const firstToken = db.medianLatency("first_token");
  if (firstToken) lines.push(`• median time to first word: *${(firstToken / 1000).toFixed(1)}s*`);

  // Reads one past the cap so a queue at the limit renders "100+" rather than a
  // flat 100 that looks like a coincidence.
  const pending = learn.pending(PENDING_CAP + 1).length;
  if (pending > 0) {
    const shown = pending > PENDING_CAP ? `${PENDING_CAP}+` : String(pending);
    lines.push("", `*waiting on you*\n${shown} candidate answer(s) to review — open pixie's Home tab to approve or drop.`);
  }

  return lines;
}

function reportText(weeksAgo = 0) {
  return reportLines(weeksAgo).join("\n");
}

function reportBlocks(weeksAgo = 0) {
  return [{ type: "section", text: { type: "mrkdwn", text: reportText(weeksAgo) } }];
}

/* -------------------------------------------------------------- schedule -- */

function reportChannel() {
  return config.reportChannel || config.slack.helpChannel || null;
}

// The most recent Monday 09:00 at or before `at`. A report is due when nothing
// has been sent since that boundary — which makes the check idempotent, so a
// restart mid-week can't trigger a second post.
function lastBoundary(at = new Date()) {
  const boundary = new Date(at);
  boundary.setHours(REPORT_HOUR, 0, 0, 0);

  const daysSinceMonday = (boundary.getDay() - REPORT_DAY + 7) % 7;
  boundary.setDate(boundary.getDate() - daysSinceMonday);

  // Before this week's boundary — the one that counts is last week's.
  if (boundary.getTime() > at.getTime()) boundary.setDate(boundary.getDate() - 7);
  return boundary.getTime();
}

function isReportDue(at = new Date()) {
  const sentAt = db.lastMetricAt(SENT_METRIC);
  return sentAt === null || sentAt < lastBoundary(at);
}

async function postWeekly(client) {
  const channel = reportChannel();
  if (!channel) return false;

  const text = reportText(0);
  await client.chat.postMessage({ channel, text: "pixie weekly report", blocks: reportBlocks(0) });
  // Recorded only after Slack accepted it, so a failed post is retried on the
  // next tick rather than silently skipped for a week.
  db.recordMetric(SENT_METRIC);
  log.info("report", `weekly report posted to ${channel}`);
  return true;
}

async function tick(client) {
  await classifyGaps().catch((e) => log.debug("report", `classify pass failed: ${e.message}`));
  await draftGaps().catch((e) => log.debug("report", `draft pass failed: ${e.message}`));
  if (!isReportDue()) return false;
  return postWeekly(client);
}

function start(client, { cycleMs = JUDGE_CYCLE_MS } = {}) {
  if (timer) return timer;
  if (!reportChannel()) {
    log.info("report", "no report channel configured — weekly report disabled, /pixie-report still works");
  }

  timer = setInterval(() => {
    tick(client).catch((e) => log.error("report", "weekly tick failed:", e.message));
  }, cycleMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  judgeGap,
  judgePrompt,
  classifyGaps,
  draftDoc,
  draftPrompt,
  draftGaps,
  draftSourceTs,
  collect,
  reportText,
  reportBlocks,
  reportChannel,
  lastBoundary,
  isReportDue,
  postWeekly,
  tick,
  start,
  stop,
  DOCS,
  TRANSIENT,
  NOISE,
  SENT_METRIC,
  WEEK_MS,
};
