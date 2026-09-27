import db = require("./db");
import llm = require("./llm");
import log = require("./log");
import configModule = require("./config");
import activeLearning = require("./activeLearning");
import type { Ticket, SlackClient } from "./types";

type DbRow = Record<string, any>;
const { config } = configModule;

interface SlackResponse {
  messages?: Array<Record<string, any>>;
  response_metadata?: { next_cursor?: string };
}

interface ThreadClient {
  conversations?: {
    replies?: (args: Record<string, unknown>) => Promise<SlackResponse>;
  };
}

interface PipelineArgs {
  ticket: Ticket;
  client?: ThreadClient | SlackClient | null;
  actorId?: string | null;
  workerId?: string | null;
}

const THREAD_FETCH_LIMIT = 1000;
const MAX_THREAD_MESSAGES = 200;
const MAX_TRANSCRIPT_CHARS = 24000;
const SUMMARY_MAX_TOKENS = 700;

const SUMMARY_SYSTEM_PROMPT = [
  "You summarize resolved Hack Club support tickets for the helper dashboard.",
  "Summarize only the supplied facts: what the requester needed, what happened in the thread, and how it was resolved.",
  "Be concise and factual. Do not add advice, greetings, or facts that are not in the thread.",
].join(" ");

// ticket id -> the running pipeline, so a second caller awaits the same run.
const inFlight = new Map<number, Promise<unknown>>();

function formatSlackMessage(message: Record<string, any>): string | null {
  if (!message?.text) return null;
  const who = message.bot_id ? "Pixie" : (message.user ? `<@${message.user}>` : "Requester");
  return `${who}: ${message.text}`;
}

function formatStoredMessage(message: Record<string, any>): string | null {
  if (!message?.content) return null;
  const who = message.user_id || message.role || "Requester";
  return `${who}: ${message.content}`;
}

function formatTimeline(events: DbRow[]): string {
  return events
    .map((event) => {
      let detail = event.detail;
      try { detail = detail ? JSON.stringify(JSON.parse(detail)) : null; } catch (_) {}
      return `${event.event_type}${event.actor_id ? ` by ${event.actor_id}` : ""}${detail ? ` (${detail})` : ""}`;
    })
    .join("; ");
}

function boundTranscript(messages: string[]): string[] {
  const bounded = messages.slice(-MAX_THREAD_MESSAGES);
  while (bounded.length > 0 && bounded.join("\n").length > MAX_TRANSCRIPT_CHARS) bounded.shift();
  if (bounded.length === 0 && messages.length > 0) return [String(messages[messages.length - 1]).slice(-MAX_TRANSCRIPT_CHARS)];
  return bounded;
}

function fallbackSummary(ticket: Ticket, timeline: DbRow[], transcript: string[] = []): string {
  const parts = [`Question: ${ticket.question}`];
  if (ticket.resolution) parts.push(`Resolution: ${ticket.resolution}`);
  const timelineParts = [];
  if (transcript.length > 0) timelineParts.push(`Thread: ${transcript.join("\n")}`);
  if (timeline.length > 0) timelineParts.push(`Events: ${formatTimeline(timeline)}`);
  if (timelineParts.length > 0) parts.push(`Timeline:\n${timelineParts.join("\n")}`);
  return parts.join("\n\n").slice(0, MAX_TRANSCRIPT_CHARS);
}

async function loadThread({ ticket, client }: { ticket: Ticket; client?: ThreadClient | SlackClient | null }): Promise<string[]> {
  if (client?.conversations?.replies) {
    try {
      const messages = [];
      let cursor = null;
      do {
        const response: SlackResponse = await client.conversations.replies({
          channel: ticket.channel,
          ts: ticket.thread_ts,
          limit: Math.min(THREAD_FETCH_LIMIT, MAX_THREAD_MESSAGES - messages.length),
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...(response?.messages || []).slice(0, MAX_THREAD_MESSAGES - messages.length));
        cursor = response?.response_metadata?.next_cursor || null;
      } while (cursor && messages.length < MAX_THREAD_MESSAGES);
      const transcript = boundTranscript(messages.map(formatSlackMessage).filter((message): message is string => message !== null));
      if (transcript.length > 0) return transcript;
    } catch (e: any) {
      log.warn("resolution", `thread fetch failed for #${ticket.id}: ${e.message}`);
    }
  }

  try {
    return boundTranscript(db.getThreadMessages(ticket.thread_ts).map((message: Record<string, any>) => formatStoredMessage(message)).filter((message: string | null): message is string => message !== null));
  } catch (e: any) {
    log.warn("resolution", `stored thread fetch failed for #${ticket.id}: ${e.message}`);
    return [];
  }
}

async function summarizeResolution({ ticket, client }: { ticket: Ticket; client?: ThreadClient | SlackClient | null }): Promise<string> {
  const timeline = db.listTicketEvents(ticket.id);
  const transcript = await loadThread({ ticket, client });
  const fallback = fallbackSummary(ticket, timeline, transcript);
  try {
    const promptContent = [
      `Question: ${ticket.question}`,
      `Resolution: ${ticket.resolution || "resolved"}`,
      transcript.length > 0 ? `Thread:\n${transcript.join("\n")}` : null,
      timeline.length > 0 ? `Timeline:\n${formatTimeline(timeline)}` : null,
    ].filter(Boolean).join("\n\n").slice(0, MAX_TRANSCRIPT_CHARS);
    const answerConfig = config.answer as unknown as Record<string, any>;
    const { text } = await llm.complete(
      {
        baseUrl: config.answer.baseUrl,
        apiKey: config.answer.apiKey,
        model: config.answer.model,
        fallback: config.answer.fallback,
        onRateLimited: answerConfig.onRateLimited,
        maxTokens: SUMMARY_MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          {
            role: "user",
            content: promptContent,
          },
        ],
      },
      "resolution-summary",
    );
    const summary = llm.stripThinking((text || "").trim());
    return summary || fallback;
  } catch (e: any) {
    log.warn("resolution", `summary generation failed for #${ticket.id}: ${e.message}`);
    return fallback;
  }
}

// Each step owns its own idempotency, so a reopened ticket that is resolved
// again still reaches the steps that have work left to do.
async function summaryStep({ ticket, client }: PipelineArgs): Promise<string | null> {
  if (db.getResolutionSummary(ticket.id)?.resolution_summary) return null;
  const summary = await summarizeResolution({ ticket, client });
  if (summary) db.setResolutionSummary(ticket.id, summary);
  return summary;
}

async function learningStep({ ticket, workerId }: PipelineArgs): Promise<unknown> {
  const learnFromResolution = activeLearning.learnFromResolution as unknown as (args: Record<string, unknown>) => Promise<unknown>;
  return learnFromResolution({ ticket, workerId });
}

const steps: Array<{ name: string; run: (args: PipelineArgs) => Promise<unknown> }> = [
  { name: "summary", run: summaryStep },
  { name: "learning", run: learningStep },
];

function onResolved({ ticket, client = null, actorId = null, workerId = null }: PipelineArgs): Promise<unknown> {
  if (!ticket?.id) return Promise.resolve();
  const existing = inFlight.get(ticket.id);
  if (existing) return existing;
  const run = runSteps({ ticket, client, actorId, workerId });
  inFlight.set(ticket.id, run);
  return run;
}

async function runSteps({ ticket, client, actorId, workerId }: PipelineArgs): Promise<Array<{ name: string; ok: boolean }>> {
  try {
    const results = [];
    for (const step of steps) {
      try {
        await step.run({ ticket, client, actorId, workerId });
        results.push({ name: step.name, ok: true });
      } catch (e: any) {
        log.warn("resolution", `${step.name} step failed for #${ticket.id}: ${e.message}`);
        results.push({ name: step.name, ok: false });
      }
    }
    return results;
  } finally {
    inFlight.delete(ticket.id);
  }
}

// Resolution work runs on its own after finishResolve returns. It is on by
// default; lib/test-setup.js pins it off so unit tests that resolve tickets
// never start model calls, and the tests that cover it call onResolved directly.
function autoRunEnabled() {
  return process.env.PIXIE_RESOLUTION_PIPELINE !== "false";
}

function schedule(args: PipelineArgs): void {
  if (!autoRunEnabled()) return;
  void Promise.resolve()
    .then(() => onResolved(args))
    .catch((e: any) => log.warn("resolution", `pipeline failed for #${args.ticket?.id}: ${e.message}`));
}

export = {
  onResolved,
  schedule,
  summarizeResolution,
  fallbackSummary,
  loadThread,
  steps,
  THREAD_FETCH_LIMIT,
  MAX_THREAD_MESSAGES,
  MAX_TRANSCRIPT_CHARS,
};
