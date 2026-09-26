const db = require("./db");
const llm = require("./llm");
const log = require("./log");
const { config } = require("./config");

const THREAD_FETCH_LIMIT = 1000;
const SUMMARY_MAX_TOKENS = 700;

const SUMMARY_SYSTEM_PROMPT = [
  "You summarize resolved Hack Club support tickets for the helper dashboard.",
  "Summarize only the supplied facts: what the requester needed, what happened in the thread, and how it was resolved.",
  "Be concise and factual. Do not add advice, greetings, or facts that are not in the thread.",
].join(" ");

const inFlight = new Set();

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

function fallbackSummary(ticket, timeline, transcript = []) {
  const parts = [`Question: ${ticket.question}`];
  if (ticket.resolution) parts.push(`Resolution: ${ticket.resolution}`);
  const timelineParts = [];
  if (transcript.length > 0) timelineParts.push(`Thread: ${transcript.join("\n")}`);
  if (timeline.length > 0) timelineParts.push(`Events: ${formatTimeline(timeline)}`);
  if (timelineParts.length > 0) parts.push(`Timeline:\n${timelineParts.join("\n")}`);
  return parts.join("\n\n");
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
          limit: THREAD_FETCH_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...(response?.messages || []));
        cursor = response?.response_metadata?.next_cursor || null;
      } while (cursor);
      const transcript = messages.map(formatSlackMessage).filter(Boolean);
      if (transcript.length > 0) return transcript;
    } catch (e) {
      log.warn("resolution", `thread fetch failed for #${ticket.id}: ${e.message}`);
    }
  }

  try {
    return db.getThreadMessages(ticket.thread_ts).map(formatStoredMessage).filter(Boolean);
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
            content: [
              `Question: ${ticket.question}`,
              `Resolution: ${ticket.resolution || "resolved"}`,
              transcript.length > 0 ? `Thread:\n${transcript.join("\n")}` : null,
              timeline.length > 0 ? `Timeline:\n${formatTimeline(timeline)}` : null,
            ].filter(Boolean).join("\n\n"),
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

const steps = [
  { name: "summary", run: summarizeResolution },
];

async function onResolved({ ticket, client = null, actorId = null }) {
  if (!ticket?.id || inFlight.has(ticket.id)) return;
  const existing = db.getResolutionSummary(ticket.id);
  if (existing?.resolution_summary) return existing.resolution_summary;

  inFlight.add(ticket.id);
  try {
    const results = [];
    for (const step of steps) {
      try {
        const result = await step.run({ ticket, client, actorId });
        if (step.name === "summary" && result) {
          db.setResolutionSummary(ticket.id, result);
        }
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

module.exports = {
  onResolved,
  summarizeResolution,
  fallbackSummary,
  loadThread,
  steps,
  THREAD_FETCH_LIMIT,
};
