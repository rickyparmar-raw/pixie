// Program timing answers use UTC dates from program.json and decline to invent
// a milestone when the question or source data is ambiguous.
import fs = require("node:fs");
import path = require("node:path");
import log = require("./log");

type UntypedInput = any;
const PROGRAM_PATH = path.join(__dirname, "..", "program.json");
const MS_PER_DAY = 24 * 60 * 60 * 1000;


const NON_TIMING_RE = /\b(?:hackatime|wakatime|hours?|storage|tracking|tracked|shows|sync|discrepancy|drift|error|why|how do i|how to|npm|code)\b/i;
const TIMING_DATE_WORDS_RE = /\b(?:deadline|release date|launch date)\b/i;


const NON_PROGRAM_DURATION_RE = /how long (?:does|do|is|will) (?:review|quest|sidequest|building|approval|processing|take)/i;


const IGNORED_MILESTONE_WORDS = new Set(["pixl", "ysws", "official", "program", "the", "hack", "club"]);

function load(filePath = PROGRAM_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e: UntypedInput) {
    if (e.code !== "ENOENT") log.warn("program", `could not read program.json: ${e.message}`);
    return null;
  }
}

function formatDate(date: UntypedInput) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function describeWhen(target: UntypedInput, now: UntypedInput) {
  const startOfDay = (d: UntypedInput) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((startOfDay(target) - startOfDay(now)) / MS_PER_DAY);

  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

function describeEntry(entry: UntypedInput, now: UntypedInput) {
  const date = parseDate(entry.date);
  if (!date) return null;

  const when = describeWhen(date, now);
  const passed = date.getTime() < now.getTime();
  const status = passed ? "already passed" : "upcoming";

  const parts = [`${entry.name}: ${formatDate(date)} — ${when} (${status})`];
  if (entry.note) parts.push(`  ${entry.note}`);
  return parts.join("\n");
}

function questionPairs(entry: UntypedInput, now: UntypedInput) {
  const date = parseDate(entry.date);
  if (!date) return [];

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

  pairs.push([
    `Has ${entry.name} happened yet? / Is it out yet? / Is ${entry.name} done?`,
    passed
      ? `Yes — ${entry.name} was ${pretty}, ${when}.`
      : `Not yet — ${entry.name} is ${pretty}, ${when}.`,
  ]);

  return pairs.map(([q, a]: UntypedInput) => `Q: ${q}\nA: ${a}`);
}

function escapeRegex(str: UntypedInput) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(value: UntypedInput) {
  // Invalid dates fall through to the normal docs path instead of producing fiction.
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildNamesRegexPattern(metadata: UntypedInput) {
  // Escape configured names before placing them in the timing matcher.
  if (metadata === null || metadata === undefined) {
    return "pixl";
  }
  const names = [];
  if (typeof metadata === "object") {
    if (typeof metadata.name === "string" && metadata.name.trim()) {
      names.push(metadata.name.trim());
    }
    if (Array.isArray(metadata.aliases)) {
      for (const a of metadata.aliases) {
        if (typeof a === "string" && a.trim()) {
          names.push(a.trim());
        }
      }
    }
  }
  if (names.length === 0) {
    return null;
  }
  return names.map(escapeRegex).join("|");
}

function buildTimingPattern(metadata: UntypedInput) {
  const namesPattern = buildNamesRegexPattern(metadata);
  if (namesPattern === null) return null;
  return new RegExp(
    `\\b(?:when (?:is|are|does|did|will|do|was|drop)|what date|how long (?:until|left|till)|how many days (?:until|left|till)|release date|launch date|is it out|out yet|come out|coming out|drop(?:s|ping|ped)?|deadline|due date)\\b|` +
    `\\b(?:is|are|has|have)\\b[^?.!]{0,30}\\blive\\b|` +
    `\\b(?:is|are|has|have|does|did|will)\\b[^?.!]{0,20}\\b(?:${namesPattern}|it|this|program|chapter)\\b[^?.!]{0,20}\\b(?:start(?:s|ed|ing)?|end(?:s|ed|ing)?|clos(?:es|ed|ing)?|launch(?:ed|ing)?|release[ds]?)\\b`,
    "i",
  );
}

function isTimingQuestion(text: UntypedInput, metadata = null) {
  const t = String(text || "");
  if (NON_TIMING_RE.test(t) && !TIMING_DATE_WORDS_RE.test(t)) return false;
  const pattern = buildTimingPattern(metadata);
  if (!pattern) return false;
  return pattern.test(t);
}

function extractMilestones(dataOrMilestones: UntypedInput) {
  if (!dataOrMilestones) return [];
  if (Array.isArray(dataOrMilestones)) return dataOrMilestones;
  if (Array.isArray(dataOrMilestones.milestones)) return dataOrMilestones.milestones;
  return [];
}

function corpusSection(now = new Date(), dataOrMilestones = load(), metadata = null) {
  const entries = extractMilestones(dataOrMilestones);
  if (entries.length === 0) return "";

  const sorted = entries.slice().sort((a: UntypedInput, b: UntypedInput) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const lines = sorted.map((entry: UntypedInput) => describeEntry(entry, now)).filter(Boolean);
  if (lines.length === 0) return "";

  const pairs = sorted.flatMap((entry: UntypedInput) => questionPairs(entry, now));

  const header = [
    `Today's date is ${formatDate(now)}.`,
    "These are the real program dates. Use them for any question about deadlines, timing, or how long is left.",
    "Never state a date or a countdown that is not listed here.",
    "",
  ];

  const tz = dataOrMilestones && !Array.isArray(dataOrMilestones) ? dataOrMilestones.timezone : null;
  const footer = tz ? [`All times are ${tz}.`] : [];

  return [...header, ...lines, "", ...pairs, "", ...footer].join("\n");
}

function directAnswer(question: UntypedInput, now = new Date(), dataOrMilestones = load(), metadata = null) {
  // Only a uniquely named or clearly program-level question gets a deterministic date answer.
  if (!isTimingQuestion(question, metadata)) return null;

  const milestones = extractMilestones(dataOrMilestones);
  const entries = milestones.filter((e: UntypedInput) => e && e.date && parseDate(e.date));
  if (entries.length === 0) return null;

  const asked = (question || "").toLowerCase();

  if (NON_PROGRAM_DURATION_RE.test(asked)) return null;

  const named = entries.filter((e: UntypedInput) =>
    e.name
      .toLowerCase()
      .split(/\s+/)
      .some((word: UntypedInput) => word.length > 3 && !IGNORED_MILESTONE_WORDS.has(word) && asked.includes(word)),
  );

  const namesPattern = buildNamesRegexPattern(metadata);
  const programTerms = new RegExp(
    `\\b(?:release|launch|out|deadline|finish|due|drop|schedule)\\b|\\b(?:is|are|has|have|does|did|will)\\b[^?.!]{0,20}\\b(?:${namesPattern}|it|this|program|chapter)\\b[^?.!]{0,20}\\b(?:start(?:s|ed|ing)?|end(?:s|ed|ing)?|launch(?:ed|ing)?|release[ds]?)\\b`,
    "i",
  );
  const entry = named.length === 1 ? named[0] : (entries.length === 1 && programTerms.test(asked) ? entries[0] : null);
  if (!entry) return null;

  const date = parseDate(entry.date);
  if (!date) return null;
  const passed = date.getTime() < now.getTime();
  const when = describeWhen(date, now);

  return {
    source: "Program timeline",
    answer: passed
      ? `${entry.name} was ${formatDate(date)} — ${when}.`
      : `not yet — ${entry.name} is ${formatDate(date)}, ${when}.`,
  };
}

export = {
  load,
  corpusSection,
  describeWhen,
  describeEntry,
  questionPairs,
  directAnswer,
  isTimingQuestion,
  PROGRAM_PATH,
};
