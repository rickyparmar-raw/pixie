// Client-safe onboarding model: the draft the five-step setup edits, how it
// persists across refreshes, and the pure helpers the step UIs read from.
// Nothing here talks to Core — activation still goes through
// activateHostedProgram, which is the only write path.

import { sourceUrlProblem } from "@/lib/sourceUrls";
import type { DocSource } from "@/lib/types";

export const ONBOARDING_STEPS = ["Program Info", "Channels", "Docs", "Helpers", "Go Live"] as const;
export type StepIndex = 0 | 1 | 2 | 3 | 4;

export type SourceKind = "notion" | "github" | "gdoc" | "markdown";

// Honest lifecycle for a source during onboarding. Nothing is fetched until
// launch: "processing" is the browser reading an uploaded file, "pending" is
// queued for Core, "error" is anything that will not sync as-is. "fetching"
// and "ready" only ever come from Core after activation (demo fixtures aside).
export type SourceStatus = "processing" | "pending" | "fetching" | "ready" | "error";

export interface DraftSource {
  id: string;
  kind: SourceKind;
  label: string;
  url?: string;
  content?: string;
  status: SourceStatus;
  error?: string;
  // What Pixie will learn from it, when we can know before syncing: headings
  // of uploaded Markdown. Link sources stay empty until Core reads them.
  outline: string[];
}

export interface DraftHelper {
  slackId: string;
  tags: string[];
}

export interface OnboardingDraft {
  version: 1;
  step: StepIndex;
  programName: string;
  programDescription: string;
  programSlug: string;
  iconUrl: string;
  helpChannelId: string;
  organizerChannelId: string;
  sources: DraftSource[];
  helpers: DraftHelper[];
}

export const EMPTY_DRAFT: OnboardingDraft = {
  version: 1,
  step: 0,
  programName: "",
  programDescription: "",
  programSlug: "",
  iconUrl: "",
  helpChannelId: "",
  organizerChannelId: "",
  sources: [],
  helpers: [],
};

export const SOURCE_KINDS: Record<SourceKind, {
  label: string;
  hint: string;
  docType: DocSource["type"];
  placeholder: string;
  host: RegExp | null;
  hostHint: string;
}> = {
  notion: { label: "Notion", hint: "Link a page", docType: "url", placeholder: "https://yourteam.notion.site/Handbook", host: /(^|\.)notion\.(so|site)$/i, hostHint: "Use a public notion.site or notion.so page link." },
  github: { label: "GitHub", hint: "Import repos", docType: "github-dir", placeholder: "https://github.com/org/repo/tree/main/docs", host: /(^|\.)github\.com$/i, hostHint: "Use a github.com repo or folder link." },
  gdoc: { label: "Google Docs", hint: "Link a doc", docType: "gdoc", placeholder: "https://docs.google.com/document/d/…", host: /^docs\.google\.com$/i, hostHint: "Use a docs.google.com link shared as “Anyone with the link”." },
  markdown: { label: "Markdown", hint: "Upload files", docType: "text", placeholder: "", host: null, hostHint: "" },
};

export const MAX_SOURCES = 5;
export const RECOMMENDED_SOURCES = 3;
export const MAX_UPLOAD_FILES = 5;
export const MAX_UPLOAD_BYTES = 250_000;
export const MAX_TOTAL_CONTENT = 300_000;

export const HELPER_TAGS = ["Reviews", "Hardware", "Software", "Grants", "Shipping", "Accounts"] as const;

const SLACK_USER_ID = /^[UW][A-Z0-9]{8,14}$/;
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{8,14}$/;

export function isSlackUserId(id: string): boolean {
  return SLACK_USER_ID.test(id);
}

export function isSlackChannelId(id: string): boolean {
  return SLACK_CHANNEL_ID.test(id);
}

export function newSourceId(): string {
  return `src_${Math.random().toString(36).slice(2, 10)}`;
}

// Link validation, stricter than the server's string-level screen: the
// server rejects private hosts, this also catches a GitHub link pasted into
// the Notion slot before it becomes a confusing sync failure.
export function sourceUrlIssue(kind: SourceKind, url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return "Paste a link first.";
  const problem = sourceUrlProblem(trimmed);
  if (problem) return problem;
  const rule = SOURCE_KINDS[kind];
  if (rule.host && !rule.host.test(new URL(trimmed).hostname)) return rule.hostHint;
  return null;
}

export function markdownOutline(content: string, max = 3): string[] {
  const headings: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[1].replace(/[*_`[\]]/g, "").trim();
    if (text && !headings.includes(text)) headings.push(text);
    if (headings.length >= max) break;
  }
  return headings;
}

export function usableSources(sources: DraftSource[]): DraftSource[] {
  return sources.filter((source) => source.status !== "error" && source.status !== "processing");
}

export function knowledgeScore(sources: DraftSource[]): { count: number; target: number; recommended: number } {
  return { count: Math.min(usableSources(sources).length, MAX_SOURCES), target: MAX_SOURCES, recommended: RECOMMENDED_SOURCES };
}

export function totalContentLength(sources: DraftSource[]): number {
  return sources.reduce((sum, source) => sum + (source.content?.length ?? 0), 0);
}

// Hidden-input rows in the exact shape parseSources() in hostedActions reads.
export function sourceFormRows(sources: DraftSource[]): { type: string; label: string; url: string; content: string }[] {
  return usableSources(sources).map((source) => ({
    type: SOURCE_KINDS[source.kind].docType,
    label: source.label,
    url: source.kind === "markdown" ? "" : source.url ?? "",
    content: source.kind === "markdown" ? source.content ?? "" : "",
  }));
}

// "U123:Hardware,Grants" — one entry per tagged helper, read by activation.
export function helperTagRows(helpers: DraftHelper[]): string[] {
  return helpers.filter((helper) => helper.tags.length > 0).map((helper) => `${helper.slackId}:${helper.tags.join(",")}`);
}

export type StepProblem = { step: StepIndex; message: string };

// Launch validation mirrors the server guards that can be checked without
// Core, so the Go Live checklist never promises something activation rejects.
export function draftProblems(draft: OnboardingDraft): StepProblem[] {
  const problems: StepProblem[] = [];
  if (!draft.programName.trim()) problems.push({ step: 0, message: "Name your program." });
  if (!isSlackChannelId(draft.helpChannelId.trim())) problems.push({ step: 1, message: "Pick a help channel." });
  if (!isSlackChannelId(draft.organizerChannelId.trim())) problems.push({ step: 1, message: "Pick a private helpers channel." });
  if (draft.helpChannelId.trim() && draft.helpChannelId.trim() === draft.organizerChannelId.trim()) {
    problems.push({ step: 1, message: "The help and helpers channels must be different." });
  }
  if (draft.iconUrl.trim() && !draft.iconUrl.trim().startsWith("https://")) problems.push({ step: 0, message: "The icon link must start with https://." });
  if (usableSources(draft.sources).length === 0) problems.push({ step: 2, message: "Add at least one doc source." });
  if (draft.sources.some((source) => source.status === "error")) problems.push({ step: 2, message: "Remove or fix the sources that failed." });
  if (totalContentLength(draft.sources) > MAX_TOTAL_CONTENT) problems.push({ step: 2, message: "Uploaded files are over 300 KB combined." });
  return problems;
}

export function stepDone(draft: OnboardingDraft, step: StepIndex): boolean {
  if (step === 3) return draft.helpers.length > 0;
  if (step === 4) return false;
  return !draftProblems(draft).some((problem) => problem.step === step);
}

// ---- Persistence --------------------------------------------------------

export function draftStorageKey(userKey: string): string {
  return `pixie.onboarding.v1:${userKey}`;
}

function asString(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

// Storage is user-controlled input: rebuild the draft field by field and drop
// anything that doesn't fit the shape rather than trusting the blob.
export function parseStoredDraft(raw: string | null): OnboardingDraft | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1) return null;
  const d = data as Record<string, unknown>;
  const step = Number(d.step);
  const kinds = Object.keys(SOURCE_KINDS);
  const statuses: SourceStatus[] = ["pending", "error"];
  const sources = (Array.isArray(d.sources) ? d.sources : []).slice(0, MAX_SOURCES).flatMap((item): DraftSource[] => {
    if (!item || typeof item !== "object") return [];
    const s = item as Record<string, unknown>;
    if (!kinds.includes(String(s.kind))) return [];
    // An upload interrupted mid-read comes back as pending only if it has content.
    const status = statuses.includes(s.status as SourceStatus) ? (s.status as SourceStatus) : "pending";
    const content = asString(s.content, MAX_TOTAL_CONTENT);
    if (s.kind === "markdown" && !content) return [];
    return [{
      id: asString(s.id, 40) || newSourceId(),
      kind: s.kind as SourceKind,
      label: asString(s.label, 120) || "Untitled source",
      url: asString(s.url) || undefined,
      content: content || undefined,
      status,
      error: asString(s.error, 300) || undefined,
      outline: (Array.isArray(s.outline) ? s.outline : []).slice(0, 3).map((line) => asString(line, 120)).filter(Boolean),
    }];
  });
  const helpers = (Array.isArray(d.helpers) ? d.helpers : []).slice(0, 20).flatMap((item): DraftHelper[] => {
    if (!item || typeof item !== "object") return [];
    const h = item as Record<string, unknown>;
    const slackId = asString(h.slackId, 20);
    if (!isSlackUserId(slackId)) return [];
    const tags = (Array.isArray(h.tags) ? h.tags : []).map((tag) => asString(tag, 40)).filter((tag) => (HELPER_TAGS as readonly string[]).includes(tag));
    return [{ slackId, tags }];
  });
  return {
    version: 1,
    step: (Number.isInteger(step) && step >= 0 && step <= 4 ? step : 0) as StepIndex,
    programName: asString(d.programName, 80),
    programDescription: asString(d.programDescription, 500),
    programSlug: asString(d.programSlug, 60),
    iconUrl: asString(d.iconUrl, 500),
    helpChannelId: asString(d.helpChannelId, 20),
    organizerChannelId: asString(d.organizerChannelId, 20),
    sources,
    helpers,
  };
}

// ---- Go Live dry run ----------------------------------------------------

const TAG_KEYWORDS: Record<(typeof HELPER_TAGS)[number], string[]> = {
  Reviews: ["review", "reviewed", "approve", "approval", "rejected", "feedback", "submission"],
  Hardware: ["hardware", "pcb", "board", "solder", "parts", "component", "kit", "arduino"],
  Software: ["software", "code", "bug", "error", "deploy", "build", "api", "github"],
  Grants: ["grant", "grants", "funding", "fund", "money", "stipend", "reimburse", "hcb"],
  Shipping: ["ship", "shipping", "shipped", "package", "tracking", "delivery", "arrive", "address"],
  Accounts: ["account", "login", "log in", "sign in", "password", "access", "email", "verify"],
};

// Every tag the question touches, strongest first (ties keep HELPER_TAGS order).
export function routeTags(question: string): (typeof HELPER_TAGS)[number][] {
  const text = question.toLowerCase();
  return HELPER_TAGS
    .map((tag) => ({ tag, hits: TAG_KEYWORDS[tag].filter((word) => text.includes(word)).length }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((entry) => entry.tag);
}

export function routeTag(question: string): (typeof HELPER_TAGS)[number] | null {
  return routeTags(question)[0] ?? null;
}

const STOP_WORDS = new Set(["the", "a", "an", "is", "are", "my", "i", "to", "of", "and", "in", "on", "for", "how", "do", "does", "what", "where", "when", "can", "it", "this", "that", "with", "be", "s"]);

function terms(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

export type DryRunResult =
  | { kind: "answer"; sourceLabel: string; snippet: string }
  | { kind: "handoff"; tag: string | null; helperId: string | null; linkSourcesPending: number };

// A local preview, not the model: search uploaded text for the best matching
// paragraph, otherwise show who the question would be handed to. Link sources
// are only read by Core at launch, so they are reported, never searched.
export function dryRun(question: string, draft: OnboardingDraft): DryRunResult {
  const wanted = new Set(terms(question));
  let best: { label: string; paragraph: string; hits: number } | null = null;
  for (const source of usableSources(draft.sources)) {
    if (!source.content) continue;
    for (const paragraph of source.content.split(/\n\s*\n/)) {
      const hits = new Set(terms(paragraph).filter((word) => wanted.has(word))).size;
      if (hits >= 2 && (!best || hits > best.hits)) best = { label: source.label, paragraph, hits };
    }
  }
  if (best) {
    const snippet = best.paragraph.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
    return { kind: "answer", sourceLabel: best.label, snippet: snippet.length > 220 ? `${snippet.slice(0, 217)}…` : snippet };
  }
  const tags = routeTags(question);
  const matchedTag = tags.find((tag) => draft.helpers.some((h) => h.tags.includes(tag))) ?? null;
  const helper = draft.helpers.find((h) => matchedTag && h.tags.includes(matchedTag)) ?? draft.helpers[0] ?? null;
  return {
    kind: "handoff",
    tag: matchedTag ?? tags[0] ?? null,
    helperId: helper?.slackId ?? null,
    linkSourcesPending: usableSources(draft.sources).filter((source) => !source.content).length,
  };
}

// ---- Local demo fixtures ------------------------------------------------
// Only rendered when the page is in local demo mode (dev-local session on a
// loopback host with PIXIE_DEMO_LOGIN=1). Never used for a real setup.

export const DEMO_DRAFT: OnboardingDraft = {
  ...EMPTY_DRAFT,
  step: 0,
  programName: "Demo Program",
  programDescription: "A sample program for previewing setup.",
  helpChannelId: "C0DEMOHELP1",
  organizerChannelId: "G0DEMOORG12",
  sources: [
    { id: "demo_handbook", kind: "notion", label: "Community Handbook", url: "https://demo.notion.site/handbook", status: "ready", outline: ["Community guidelines and code of conduct", "Member onboarding flow", "Roles, permissions, and access"] },
    { id: "demo_repo", kind: "github", label: "Product Repository", url: "https://github.com/demo/product/tree/main/docs", status: "ready", outline: ["Setup instructions and development workflow", "Contribution guidelines", "Common troubleshooting issues"] },
    { id: "demo_help", kind: "gdoc", label: "Help Center", url: "https://docs.google.com/document/d/demo", status: "ready", outline: ["FAQ and support procedures", "Feature documentation", "Known issues and workarounds"] },
  ],
  helpers: [
    { slackId: "U0DEMOGABIN", tags: ["Hardware", "Grants"] },
    { slackId: "U0DEMOMAYA1", tags: ["Software", "Reviews"] },
  ],
};

export const DEMO_PEOPLE: Record<string, { name: string; handle: string }> = {
  U0DEMOGABIN: { name: "Gabin", handle: "gabin" },
  U0DEMOMAYA1: { name: "Maya", handle: "maya" },
};
