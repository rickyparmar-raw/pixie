// Summarizes a Slack thread for helpers, extracting the asker, core problem,
// troubleshooting history, and current status.
const { config } = require("./config");
const llm = require("./llm");
const log = require("./log");

// One page covers a real debug arc; longer threads repeat the same attempts.
const THREAD_FETCH_LIMIT = 50;
// Caps the helper summary so it stays a glanceable handoff, not a transcript.
const SUMMARY_MAX_TOKENS = 1000;

const HELPER_SUMMARY_SYSTEM_PROMPT = [
  "You are an assistant for helpers and mentors in a Hack Club technical support channel.",
  "Your task is to summarize a Slack discussion/support thread so a helper can jump in and understand the situation immediately without reading through every message.",
  "Output your summary cleanly in Slack mrkdwn format using the following structure:",
  "• *Asker:* <@user_id>",
  "• *Goal / Problem:* 1-2 sentences summarizing what the user is trying to accomplish or the error/blocker they encountered.",
  "• *What Was Tried:* Bulleted list of key troubleshooting steps, code changes, logs, or suggestions that took place.",
  "• *Current Status:* Where things left off, what is currently blocking the user, or if it appears resolved.",
  "Keep it concise, high-signal, and factual. Do NOT include filler, conversational fluff, or introductory greetings.",
].join("\n");

function buildTranscript(messages) {
  return messages
    .filter((m) => m && m.text)
    .map((m) => `${m.bot_id ? "assistant (bot)" : (m.user ? `<@${m.user}>` : "user")}: ${m.text}`)
    .join("\n");
}

async function summarizeThreadForHelper({ client, channel, threadTs }) {
  const { messages } = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: THREAD_FETCH_LIMIT,
  });
  const transcript = buildTranscript(messages || []);
  if (!transcript) return null;
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
        { role: "system", content: HELPER_SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: `Here is the Slack thread transcript:\n\n${transcript}` },
      ],
    },
    "sum-thread",
  );
  const reply = llm.stripThinking((text || "").trim());
  return reply || null;
}

module.exports = {
  summarizeThreadForHelper,
  buildTranscript,
  THREAD_FETCH_LIMIT,
  HELPER_SUMMARY_SYSTEM_PROMPT,
};
