const db = require("./db");
const llm = require("./llm");
const log = require("./log");
const { config } = require("./config");
const activeLearning = require("./activeLearning");

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
const inFlight = new Map();

function formatSlackMessage(message) {
  if (!message?.text) return null;
  const who = message.bot_id ? "Pixie" : (message.user ? `<@${message.user}>` : "Requester");
  return `${who}: ${message.text}`;
}

function formatStoredMessage(message) {
  if (!message?.content) return null;
  const who = message.user_id || message.role || "Requester";
  return `${who}: ${message.content}`;
}

function formatTimeline(events) {
  return events
    .map((event) => {
      let detail = event.detail;
      try { detail = detail ? JSON.stringify(JSON.parse(detail)) : null; } catch (_) {}
      return `${event.event_type}${event.actor_id ? ` by ${event.actor_id}` : ""}${detail ? ` (${detail})` : ""}`;
    })
    .join("; ");
}

function boundTranscript(messages) {
  const bounded = messages.slice(-MAX_THREAD_MESSAGES);
  while (bounded.length > 0 && bounded.join("\n").length > MAX_TRANSCRIPT_CHARS) bounded.shift();
  if (bounded.length === 0 && messages.length > 0) return [String(messages[messages.length - 1]).slice(-MAX_TRANSCRIPT_CHARS)];
  return bounded;
}

function fallbackSummary(ticket, timeline, transcript = []) {
  const parts = [`Question: ${ticket.question}`];
  if (ticket.resolution) parts.push(`Resolution: ${ticket.resolution}`);
  const timelineParts = [];
  if (transcript.length > 0) timelineParts.push(`Thread: ${transcript.join("\n")}`);
  if (timeline.length > 0) timelineParts.push(`Events: ${formatTimeline(timeline)}`);
  if (timelineParts.length > 0) parts.push(`Timeline:\n${timelineParts.join("\n")}`);
  return parts.join("\n\n").slice(0, MAX_TRANSCRIPT_CHARS);
}

async function loadThread({ ticket, client }) {
  if (client?.conversations?.replies) {
    try {
      const messages = [];
      let cursor = null;
      do {
        const response = await client.conversations.replies({
          channel: ticket.channel,
          ts: ticket.thread_ts,
          limit: Math.min(THREAD_FETCH_LIMIT, MAX_THREAD_MESSAGES - messages.length),
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...(response?.messages || []).slice(0, MAX_THREAD_MESSAGES - messages.length));
        cursor = response?.response_metadata?.next_cursor || null;
      } while (cursor && messages.length < MAX_THREAD_MESSAGES);
      const transcript = boundTranscript(messages.map(formatSlackMessage).filter(Boolean));
      if (transcript.length > 0) return transcript;
    } catch (e) {
      log.warn("resolution", `thread fetch failed for #${ticket.id}: ${e.message}`);
    }
  }

  try {
    return boundTranscript(db.getThreadMessages(ticket.thread_ts).map(formatStoredMessage).filter(Boolean));
  } catch (e) {
    log.warn("resolution", `stored thread fetch failed for #${ticket.id}: ${e.message}`);
    return [];
  }
}

async function summarizeResolution({ ticket, client }) {
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
    const { text } = await llm.complete(
      {
        baseUrl: config.answer.baseUrl,
        apiKey: config.answer.apiKey,
        model: config.answer.model,
        fallback: config.answer.fallback,
        onRateLimited: config.answer.onRateLimited,
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
  } catch (e) {
    log.warn("resolution", `summary generation failed for #${ticket.id}: ${e.message}`);
    return fallback;
  }
}

// Each step owns its own idempotency, so a reopened ticket that is resolved
// again still reaches the steps that have work left to do.
async function summaryStep({ ticket, client }) {
  if (db.getResolutionSummary(ticket.id)?.resolution_summary) return null;
  const summary = await summarizeResolution({ ticket, client });
  if (summary) db.setResolutionSummary(ticket.id, summary);
  return summary;
}

async function learningStep({ ticket, workerId }) {
  return activeLearning.learnFromResolution({ ticket, workerId });
}

const steps = [
  { name: "summary", run: summaryStep },
  { name: "learning", run: learningStep },
];

function onResolved({ ticket, client = null, actorId = null, workerId = null }) {
  if (!ticket?.id) return Promise.resolve();
  if (inFlight.has(ticket.id)) return inFlight.get(ticket.id);
  const run = runSteps({ ticket, client, actorId, workerId });
  inFlight.set(ticket.id, run);
  return run;
}

async function runSteps({ ticket, client, actorId, workerId }) {
  try {
    const results = [];
    for (const step of steps) {
      try {
        await step.run({ ticket, client, actorId, workerId });
        results.push({ name: step.name, ok: true });
      } catch (e) {
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

function schedule(args) {
  if (!autoRunEnabled()) return;
  void Promise.resolve()
    .then(() => onResolved(args))
    .catch((e) => log.warn("resolution", `pipeline failed for #${args.ticket?.id}: ${e.message}`));
}

module.exports = {
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
