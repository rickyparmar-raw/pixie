// Helper drafts are read-only: a human decides whether anything is sent or taught.
// Grounding uses the requester pipeline so helper citations and silence rules match.
const lookup = require("./lookup");
const retrieve = require("./retrieve");
const knowledge = require("./knowledge");
const context = require("./context");
const db = require("./db");
const log = require("./log");
const audit = require("./audit");
const rateLimit = require("./rateLimit");
const { config } = require("./config");
const respond = require("./respond");
import type { Program, Ticket } from "./types";

interface ProgramRef extends Pick<Program, "id"> {}
interface AnswerResult { source: string | null; answer: string | null }
interface TranscriptMessage { role?: string; user_id?: string; content?: string }
interface TicketEvent { event_type: string; actor_id: string | null }
interface RetrievalIndex { docs: Array<{ chunk: { source: string; heading?: string; text: string }; length: number }> }
interface Verdict { sentence: string; verdict: string; evidence: Evidence[]; contradiction?: { against: Evidence } }
interface Evidence { source: string; heading: string | null; excerpt: string; score: number }
interface SimilarCandidate { ticketId: number; question: string; summary: string | null | undefined; resolution: string | null; category: string | null | undefined; resolvedAt: number | null; similarity: number }
interface CopilotResponse {
  error?: string;
  draft?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  grounded?: boolean;
  confidence?: number;
  verification?: string;
  programId?: string | null;
  improved?: string;
  notes?: string[];
  changed?: boolean;
  summary?: string;
  aiPolished?: boolean;
  verdicts?: Verdict[];
  counts?: Record<string, number>;
  candidates?: SimilarCandidate[];
}
type RankedChunk = { chunk: { source: string; heading?: string; text: string }; value: number };

const COPILOT_WINDOW_MS = 60 * 1000;
const COPILOT_MAX_PER_WINDOW = 20;
const GROUNDED_CONFIDENCE = 0.8;
const UNGROUNDED_CONFIDENCE = 0.2;
const FACTUAL_TOKEN_RE = /\b\d[\d.,]*\b|https?:\/\/\S+|<#[A-Z0-9]+(?:\|[^>]+)?>|#[a-z0-9_-]+|"[^"]+"/gi;
const SUMMARY_TAIL = 12;
const SUMMARY_LINE_CHARS = 300;
const SUMMARY_PROMPT_CHARS = 3000;
const SUMMARY_POLISH_TOKENS = 300;
const OPPOSITION = [
  [/\bcan\b/i, /\b(can't|cannot|not allowed|isn't allowed)\b/i],
  [/\bsupported\b/i, /\b(not supported|unsupported)\b/i],
  [/\bmust\b/i, /\b(must not|mustn't|never)\b/i],
];
const SIMILAR_SCAN_LIMIT = 200;
const SIMILAR_RETURN_MAX = 10;

// Draft bursts are bounded per helper so retries cannot exhaust the model budget.

function checkBudget(actorId: string): { error: string } | null {
  const res = rateLimit.check(`copilot:${actorId}`, { windowMs: COPILOT_WINDOW_MS, max: COPILOT_MAX_PER_WINDOW });
  if (res.allowed) return null;
  return { error: "copilot rate limited — try again in a minute" };
}

function auditCopilot(programId: string, actorId: string | null, action: string, metadata: Record<string, unknown> | null = null): void {
  audit.record({ programId, actorId, action: `copilot.${action}`, entityType: "copilot", entityId: null, metadata });
}

function draftVerdict(result: AnswerResult | null): CopilotResponse {
  const grounded = respond.isGroundedAnswer(result);
  return {
    draft: result && result.answer ? result.answer : null,
    source: (result && result.source) || null,
    sourceUrl: result && result.source ? knowledge.getSourceUrl(result.source) : null,
    grounded,
    confidence: grounded ? GROUNDED_CONFIDENCE : UNGROUNDED_CONFIDENCE,
    verification: grounded ? "grounded in cited source" : "not grounded — review against docs before sending",
  };
}

function threadContextFor(threadTs: string | null): string {
  if (!threadTs) return "";
  try {
    if (!context.getThreadContext) return "";
    return context.getThreadContext(threadTs) || "";
  } catch (e) {
    log.warn("copilot", `failed to get thread context for ${threadTs}: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

async function draftReply({ program, question, threadTs = null }: { program: ProgramRef | null; question: string; threadTs?: string | null }): Promise<CopilotResponse> {
  // A null grounded answer is a signal to escalate, not an invitation to improvise.
  const programId = program ? program.id : null;
  const result = await lookup.answerOrChat(question, threadContextFor(threadTs), { program });
  return { ...draftVerdict(result), programId };
}

async function ask({ program, question, threadTs = null }: { program: ProgramRef | null; question: string; threadTs?: string | null }): Promise<CopilotResponse> {
  const result = await lookup.answerOrChat(question, threadContextFor(threadTs), { program });
  return { ...draftVerdict(result), programId: program ? program.id : null };
}

async function completeHelper(prompt: string, maxTokens = 600): Promise<string> {
  const llm = require("./llm");
  const tier = config.answer;
  const res = await llm.complete(
    {
      apiKey: tier.apiKey,
      baseUrl: tier.baseUrl,
      model: tier.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      temperature: 0.2,
      ...(tier.fallback ? { fallback: tier.fallback } : {}),
      ...(tier.onRateLimited ? { onRateLimited: tier.onRateLimited } : {}),
    },
    "copilot",
  );
  if (!res || !res.text) return "";
  return res.text.trim();
}

function factualTokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of String(text || "").matchAll(FACTUAL_TOKEN_RE)) found.add(m[0]);
  return found;
}

function tokenNotes(before: Set<string>, after: Set<string>): string[] {
  const notes: string[] = [];
  for (const tok of after) {
    if (!before.has(tok)) notes.push(`added factual token: ${tok}`);
  }
  for (const tok of before) {
    if (!after.has(tok)) notes.push(`dropped factual token: ${tok}`);
  }
  return notes;
}

async function improveReply({ text }: { text: string }): Promise<CopilotResponse> {
  const clean = String(text || "").trim();
  if (!clean) return { error: "reply text required" };
  const before = factualTokens(clean);
  let improved = "";
  try {
    improved = await completeHelper(
      `Rewrite this support reply for clarity, tone, and conciseness. Do NOT add facts, dates, numbers, or links that are not already present. Keep it short.\n\n${clean}`,
    );
  } catch (e) {
    log.warn("copilot", `improve failed: ${e instanceof Error ? e.message : String(e)}`);
    return { improved: clean, notes: ["AI unavailable — returning the original text unchanged"], changed: false };
  }
  if (!improved) return { improved: clean, notes: ["AI returned nothing — original kept"], changed: false };
  return { improved, notes: tokenNotes(before, factualTokens(improved)), changed: improved !== clean };
}

function loadTranscript(messages: TranscriptMessage[] | null, threadTs: string | null): TranscriptMessage[] {
  if (Array.isArray(messages) && messages.length > 0) return messages;
  if (!threadTs) return [];
  try {
    return db.getThreadMessages(threadTs) || [];
  } catch (e) {
    log.warn("copilot", `failed to load transcript for thread ${threadTs}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function formatTranscriptLine(m: TranscriptMessage): string {
  const who = m.role === "assistant" ? "pixie" : m.user_id || m.role || "user";
  return `${who}: ${(m.content || "").slice(0, SUMMARY_LINE_CHARS)}`;
}

function extractiveSummary(ticket: Ticket | null, transcript: TranscriptMessage[], timeline: TicketEvent[]): string {
  const parts = [];
  if (ticket) {
    parts.push(`Question: ${ticket.question}`);
    if (ticket.summary) parts.push(`Triage: ${ticket.summary}`);
    parts.push(`Status: ${ticket.status}${ticket.assignee_id ? ` (assignee <@${ticket.assignee_id}>)` : ""}`);
  }
  const lines = transcript.slice(-SUMMARY_TAIL).map(formatTranscriptLine);
  if (lines.length > 0) parts.push(`Recent thread:\n${lines.join("\n")}`);
  if (timeline.length > 0) {
    parts.push(`Events: ${timeline.map((e: TicketEvent) => `${e.event_type}${e.actor_id ? ` by <@${e.actor_id}>` : ""}`).join(", ")}`);
  }
  return parts.join("\n\n") || "No thread context available.";
}

async function summarizeThread({ program, ticket = null, threadTs = null, messages = null }: { program: ProgramRef | null; ticket?: Ticket | null; threadTs?: string | null; messages?: TranscriptMessage[] | null }): Promise<CopilotResponse> {
  const transcript = loadTranscript(messages, threadTs);
  const timeline = ticket ? db.listTicketEvents(ticket.id, 50) : [];
  const extractive = extractiveSummary(ticket, transcript, timeline);
  let polished = null;
  try {
    polished = await completeHelper(
      `Condense this support-thread state into 3 short bullets: what the user needs, what has been tried, what remains unresolved. No greeting, no new facts.\n\n${extractive.slice(0, SUMMARY_PROMPT_CHARS)}`,
      SUMMARY_POLISH_TOKENS,
    );
  } catch (e) {
    log.debug("copilot", `summarize polish failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { summary: polished || extractive, aiPolished: !!polished, programId: program ? program.id : null };
}

function splitSentences(text: string): string[] {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function evidenceFor(ranked: RankedChunk[]): Evidence[] {
  return ranked.slice(0, 2).map((r: RankedChunk) => ({
    source: r.chunk.source,
    heading: r.chunk.heading || null,
    excerpt: r.chunk.text.slice(0, 200),
    score: Number(r.value.toFixed(3)),
  }));
}

function findContradiction(sentence: string, excerpt: string): boolean {
  for (const [pos, neg] of OPPOSITION) {
    if ((pos.test(sentence) && neg.test(excerpt)) || (neg.test(sentence) && pos.test(excerpt))) return true;
  }
  return false;
}

function checkSentence(index: RetrievalIndex, sentence: string): Verdict | null {
  const terms = retrieve.tokenize(sentence);
  if (terms.length === 0) return null;
  const ranked = retrieve.score(index, terms).slice(0, 3);
  const top = ranked[0];
  if (!top) return { sentence, verdict: "unsupported", evidence: [] };
  const evidence = evidenceFor(ranked);
  if (!findContradiction(sentence, evidence[0].excerpt)) {
    return { sentence, verdict: "supported", evidence };
  }
  return { sentence, verdict: "contradiction", evidence, contradiction: { against: evidence[0] } };
}

async function factCheck({ program, text }: { program: ProgramRef | null; text: string }): Promise<CopilotResponse> {
  const programId = program ? program.id : null;
  let index = null;
  try {
    index = knowledge.getIndex(programId);
  } catch (e) {
    return { error: `no retrieval index for program: ${e instanceof Error ? e.message : String(e)}` };
  }
  const verdicts = [];
  for (const sentence of splitSentences(text)) {
    const verdict = checkSentence(index, sentence);
    if (verdict) verdicts.push(verdict);
  }
  const counts = verdicts.reduce((acc: Record<string, number>, v: Verdict) => {
    acc[v.verdict] = (acc[v.verdict] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  return { verdicts, counts, programId };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), SIMILAR_RETURN_MAX);
}

function findSimilar({ programId, question, limit = 5 }: { programId: string; question: string; limit?: number }): CopilotResponse {
  if (!programId || !question) return { error: "programId and question required" };
  let resolved = [];
  try {
    resolved = db.handle().query(`SELECT * FROM tickets WHERE program_id = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT ${SIMILAR_SCAN_LIMIT}`).all(programId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const overlap = require("./gapClusters").pairOverlap;
  const ranked = (resolved as Ticket[])
    .map((t: Ticket) => ({
      ticketId: t.id,
      question: t.question,
      summary: t.summary,
      resolution: t.resolution,
      category: t.category,
      resolvedAt: t.resolved_at,
      similarity: Number(overlap(question, `${t.question} ${t.summary || ""}`).toFixed(3)),
    }))
    .filter((c: SimilarCandidate) => c.similarity > 0)
    .sort((a: SimilarCandidate, b: SimilarCandidate) => b.similarity - a.similarity)
    .slice(0, clampLimit(limit));
  return { candidates: ranked, programId };
}

export = {
  checkBudget,
  draftReply,
  improveReply,
  summarizeThread,
  factCheck,
  findSimilar,
  ask,
  auditCopilot,
  factualTokens,
};
