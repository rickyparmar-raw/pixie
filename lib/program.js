// Program timeline. "When does X close" is the most-asked category for a YSWS
// program, and a date written into a doc goes stale silently — it still reads
// as correct long after it's passed. These are computed on every corpus
// refresh instead, so pixie says "in 4 days" and says "closed" once it has.
const fs = require("fs");
const path = require("path");
const log = require("./log");

const PROGRAM_PATH = path.join(__dirname, "..", "program.json");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function load(filePath = PROGRAM_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") log.warn("program", `could not read program.json: ${e.message}`);
    return null;
  }
}

// UTC explicitly: entry.date strings parse as UTC midnight, so rendering in the
// process's local zone can drift a full calendar day off — a Railway container
// with TZ=America/New_York rendered "2026-08-18" as "August 17, 2026".
function formatDate(date) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Whole-day granularity: "in 1 day" reads better than "in 23 hours" for a
// deadline, and avoids implying a precision the dates don't have.
function describeWhen(target, now) {
  const startOfDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((startOfDay(target) - startOfDay(now)) / MS_PER_DAY);

  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

function describeEntry(entry, now) {
  const date = new Date(entry.date);
  if (Number.isNaN(date.getTime())) return null;

  const when = describeWhen(date, now);
  const passed = date.getTime() < now.getTime();
  const status = passed ? "already passed" : "upcoming";

  const parts = [`${entry.name}: ${formatDate(date)} — ${when} (${status})`];
  if (entry.note) parts.push(`  ${entry.note}`);
  return parts.join("\n");
}

// The rest of the corpus is Q/A pairs, and the grounded prompt matches that
// shape far more reliably than prose. Without this, "is pixl released yet?"
// declined even though the date was right there in the timeline — the model
// didn't recognise it as a question the section covered.
function questionPairs(entry, now) {
  const date = new Date(entry.date);
  if (Number.isNaN(date.getTime())) return [];

  const passed = date.getTime() < now.getTime();
  const when = describeWhen(date, now);
  const pretty = formatDate(date);
  const extra = Array.isArray(entry.questions) ? entry.questions : [];

  const pairs = [
    [
      [`When is ${entry.name}?`, `What date is ${entry.name}?`, ...extra].join(" / "),
      `${pretty} — ${when}.`,
    ],
  ];

  // "Has it happened yet" is a different question from "when is it", and gets
  // asked at least as often in the run-up to a launch.
  pairs.push([
    `Has ${entry.name} happened yet? / Is it out yet? / Is ${entry.name} done?`,
    passed
      ? `Yes — ${entry.name} was ${pretty}, ${when}.`
      : `Not yet — ${entry.name} is ${pretty}, ${when}.`,
  ]);

  return pairs.map(([q, a]) => `Q: ${q}\nA: ${a}`);
}

// Returns "" when there's no program.json or no usable dates, so the section
// is omitted entirely rather than inviting the model to guess.
function corpusSection(now = new Date(), data = load()) {
  if (!data) return "";

  const entries = Array.isArray(data.milestones) ? data.milestones : [];
  const sorted = entries.slice().sort((a, b) => new Date(a.date) - new Date(b.date));

  const lines = sorted.map((entry) => describeEntry(entry, now)).filter(Boolean);
  if (lines.length === 0) return "";

  const pairs = sorted.flatMap((entry) => questionPairs(entry, now));

  const header = [
    `Today's date is ${formatDate(now)}.`,
    "These are the real program dates. Use them for any question about deadlines, timing, or how long is left.",
    "Never state a date or a countdown that is not listed here.",
    "",
  ];

  const footer = data.timezone ? [`All times are ${data.timezone}.`] : [];

  return [...header, ...lines, "", ...pairs, "", ...footer].join("\n");
}

// Asking whether something has happened is a timing question, but the model
// reads it as a yes/no state question and — against an instruction to decline
// anything the docs don't "clearly cover" — returns NONE maybe two times in
// three. Falling through to the ungrounded chat path is the dangerous outcome:
// that's where "yep, pixl is live and running" came from.
//
// The dates are exact and computed, so this is a lookup, not a judgement.
// Used only as a safety net *after* the model declines — a normal grounded
// answer still wins, so phrasing stays natural.
// "live" is only included in an is-X-live shape — a bare \blive\b would match
// "where do you live" and answer it with a release date.
const TIMING_PATTERN =
  /\b(?:when|what date|how long|how many days|release[ds]?|releasing|launch(?:ed|ing)?|out yet|is it out|come out|coming out|drop(?:s|ping|ped)?|deadline|due|starts?|ends?|closes?)\b|\b(?:is|are|has|have)\b[^?.!]{0,30}\blive\b/i;

function isTimingQuestion(text) {
  return TIMING_PATTERN.test(text || "");
}

// Returns { source, answer } shaped like a grounded answer, or null when this
// isn't a timing question, there are no dates, or which milestone is meant is
// ambiguous — in which case the normal fallback path takes over.
function directAnswer(question, now = new Date(), data = load()) {
  if (!isTimingQuestion(question)) return null;

  const entries = (Array.isArray(data?.milestones) ? data.milestones : []).filter(
    (e) => !Number.isNaN(new Date(e.date).getTime()),
  );
  if (entries.length === 0) return null;

  const asked = (question || "").toLowerCase();
  const named = entries.filter((e) =>
    e.name
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.length > 3 && asked.includes(word)),
  );

  // One milestone: unambiguous. Several: only answer if the question names one.
  const entry = named.length === 1 ? named[0] : entries.length === 1 ? entries[0] : null;
  if (!entry) return null;

  const date = new Date(entry.date);
  const passed = date.getTime() < now.getTime();
  const when = describeWhen(date, now);

  return {
    source: "Program timeline",
    answer: passed
      ? `${entry.name} was ${formatDate(date)} — ${when}.`
      : `not yet — ${entry.name} is ${formatDate(date)}, ${when}.`,
  };
}

module.exports = {
  load,
  corpusSection,
  describeWhen,
  describeEntry,
  questionPairs,
  directAnswer,
  isTimingQuestion,
  PROGRAM_PATH,
};
