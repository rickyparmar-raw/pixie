import fs = require("node:fs");
import path = require("node:path");
import log = require("./log");

interface Milestone {
  name: string;
  date: string | number | Date;
  note?: string;
  questions?: string[];
}

interface ProgramData {
  milestones?: Milestone[];
  timezone?: string;
}

interface ProgramMetadata {
  name?: string | null;
  aliases?: unknown[];
}
const PROGRAM_PATH = path.join(__dirname, "..", "config", "program.json");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const NON_TIMING_RE =
  /\b(?:hackatime|wakatime|hours?|storage|tracking|tracked|shows|sync|discrepancy|drift|error|why|how do i|how to|npm|code)\b/i;
const TIMING_DATE_WORDS_RE = /\b(?:deadline|release date|launch date)\b/i;

const NON_PROGRAM_DURATION_RE =
  /how long (?:does|do|is|will) (?:review|quest|sidequest|building|approval|processing|take)/i;

const IGNORED_MILESTONE_WORDS = new Set(["official", "program", "the", "hack", "club"]);

function load(filePath = PROGRAM_PATH): ProgramData | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ProgramData;
  } catch (e: unknown) {
    const error = e as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") log.warn("program", `could not read program.json: ${error.message}`);
    return null;
  }
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function describeWhen(target: Date, now: Date) {
  const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((startOfDay(target) - startOfDay(now)) / MS_PER_DAY);

  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

function describeEntry(entry: Milestone, now: Date) {
  const date = parseDate(entry.date);
  if (!date) return null;

  const when = describeWhen(date, now);
  const passed = date.getTime() < now.getTime();
  const status = passed ? "already passed" : "upcoming";

  const parts = [`${entry.name}: ${formatDate(date)} — ${when} (${status})`];
  if (entry.note) parts.push(`  ${entry.note}`);
  return parts.join("\n");
}

function questionPairs(entry: Milestone, now: Date) {
  const date = parseDate(entry.date);
  if (!date) return [];

  const passed = date.getTime() < now.getTime();
  const when = describeWhen(date, now);
  const pretty = formatDate(date);
  const extra = Array.isArray(entry.questions) ? entry.questions : [];

  const pairs = [
    [[`When is ${entry.name}?`, `What date is ${entry.name}?`, ...extra].join(" / "), `${pretty} — ${when}.`],
  ];

  pairs.push([
    `Has ${entry.name} happened yet? / Is it out yet? / Is ${entry.name} done?`,
    passed ? `Yes — ${entry.name} was ${pretty}, ${when}.` : `Not yet — ${entry.name} is ${pretty}, ${when}.`,
  ]);

  return pairs.map(([q, a]) => `Q: ${q}\nA: ${a}`);
}

function escapeRegex(str: string) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(value: string | number | Date | null | undefined) {
  // Invalid dates
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildNamesRegexPattern(metadata: ProgramMetadata | null) {
  if (metadata === null || metadata === undefined) {
    return null;
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

function buildTimingPattern(metadata: ProgramMetadata | null) {
  const namesPattern = buildNamesRegexPattern(metadata);
  if (namesPattern === null) return null;
  return new RegExp(
    `\\b(?:when (?:is|are|does|did|will|do|was|drop)|what date|how long (?:until|left|till)|how many days (?:until|left|till)|release date|launch date|is it out|out yet|come out|coming out|drop(?:s|ping|ped)?|deadline|due date)\\b|` +
      `\\b(?:is|are|has|have)\\b[^?.!]{0,30}\\blive\\b|` +
      `\\b(?:is|are|has|have|does|did|will)\\b[^?.!]{0,20}\\b(?:${namesPattern}|it|this|program|chapter)\\b[^?.!]{0,20}\\b(?:start(?:s|ed|ing)?|end(?:s|ed|ing)?|clos(?:es|ed|ing)?|launch(?:ed|ing)?|release[ds]?)\\b`,
    "i",
  );
}

function isTimingQuestion(text: string, metadata: ProgramMetadata | null = null) {
  const t = String(text || "");
  if (NON_TIMING_RE.test(t) && !TIMING_DATE_WORDS_RE.test(t)) return false;
  const pattern = buildTimingPattern(metadata);
  if (!pattern) return false;
  return pattern.test(t);
}

function extractMilestones(dataOrMilestones: ProgramData | Milestone[] | null | undefined): Milestone[] {
  if (!dataOrMilestones) return [];
  if (Array.isArray(dataOrMilestones)) return dataOrMilestones;
  if (Array.isArray(dataOrMilestones.milestones)) return dataOrMilestones.milestones;
  return [];
}

function corpusSection(
  now = new Date(),
  dataOrMilestones: ProgramData | Milestone[] | null = load(),
  metadata: ProgramMetadata | null = null,
) {
  const entries = extractMilestones(dataOrMilestones);
  if (entries.length === 0) return "";

  const sorted = entries.slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const lines = sorted.map((entry) => describeEntry(entry, now)).filter((line): line is string => Boolean(line));
  if (lines.length === 0) return "";

  const pairs = sorted.flatMap((entry) => questionPairs(entry, now));

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

function directAnswer(
  question: string,
  now = new Date(),
  dataOrMilestones: ProgramData | Milestone[] | null = load(),
  metadata: ProgramMetadata | null = null,
) {
  if (!isTimingQuestion(question, metadata)) return null;

  const milestones = extractMilestones(dataOrMilestones);
  const entries = milestones.filter((e) => e && e.date && parseDate(e.date));
  if (entries.length === 0) return null;

  const asked = (question || "").toLowerCase();

  if (NON_PROGRAM_DURATION_RE.test(asked)) return null;

  const named = entries.filter((e) =>
    e.name
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.length > 3 && !IGNORED_MILESTONE_WORDS.has(word) && asked.includes(word)),
  );

  const namesPattern = buildNamesRegexPattern(metadata);
  const programTerms = new RegExp(
    `\\b(?:release|launch|out|deadline|finish|due|drop|schedule)\\b|\\b(?:is|are|has|have|does|did|will)\\b[^?.!]{0,20}\\b(?:${namesPattern || "program"}|it|this|program|chapter)\\b[^?.!]{0,20}\\b(?:start(?:s|ed|ing)?|end(?:s|ed|ing)?|launch(?:ed|ing)?|release[ds]?)\\b`,
    "i",
  );
  const entry = named.length === 1 ? named[0] : entries.length === 1 && programTerms.test(asked) ? entries[0] : null;
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
