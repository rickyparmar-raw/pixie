// Summarizes a Slack thread for helpers, extracting the asker, core problem,
// troubleshooting history, and current status.
import configModule = require("./config");
import llm = require("./llm");
import log = require("./log");

const { config } = configModule;
const answerConfig = config.answer as typeof config.answer & { onRateLimited?: unknown };

interface ThreadMessage {
  text?: string;
  bot_id?: string;
  user?: string;
}
interface ThreadClient {
  conversations: {
    replies(args: { channel: string; ts: string; limit: number }): Promise<{ messages?: ThreadMessage[] }>;
  };
}

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

function buildTranscript(messages: ThreadMessage[]): string {
  return messages
    .filter((m) => m && m.text)
    .map((m) => `${m.bot_id ? "assistant (bot)" : (m.user ? `<@${m.user}>` : "user")}: ${m.text}`)
    .join("\n");
}

async function summarizeThreadForHelper({ client, channel, threadTs }: { client: ThreadClient; channel: string; threadTs: string }): Promise<string | null> {
  const { messages } = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: THREAD_FETCH_LIMIT,
  });
  const transcript = buildTranscript(messages || []);
  if (!transcript) return null;
  const { text } = await llm.complete(
    {
      baseUrl: answerConfig.baseUrl,
      apiKey: answerConfig.apiKey,
      model: answerConfig.model,
      fallback: answerConfig.fallback,
      onRateLimited: answerConfig.onRateLimited,
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

export = {
  summarizeThreadForHelper,
  buildTranscript,
  THREAD_FETCH_LIMIT,
  HELPER_SUMMARY_SYSTEM_PROMPT,
};
