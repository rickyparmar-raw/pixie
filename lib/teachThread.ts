// Extracts a reusable Q :: A fact from a Slack thread without writing it directly to knowledge.
import configModule = require("./config");
import llm = require("./llm");
import learn = require("./learn");
import answer = require("./answer");
import type { ProviderTier } from "./types";

const { config } = configModule;
const { MAX_TOKENS } = answer;
const answerConfig: ProviderTier = config.answer;

interface ThreadMessage {
  text?: string;
  bot_id?: string;
}
interface ThreadClient {
  conversations: {
    replies(args: { channel: string; ts: string; limit: number }): Promise<{ messages?: ThreadMessage[] }>;
  };
}
interface TeachResult {
  question: string;
  answer: string;
}

const THREAD_FETCH_LIMIT = 50;
const DECLINE_MARKER = "NONE";

const SYSTEM_PROMPT = [
  "You read a Slack discussion/help thread and extract a comprehensive, reusable question-and-answer fact for an AI FAQ knowledge base.",
  "The question should clearly describe the question, problem, or topic discussed in the thread as a future user would ask it.",
  "The answer should summarize the complete solution, resolution, or explanation agreed upon in the thread as a clear, standalone factual answer (do not use pronouns like 'they said' or 'see above').",
  'Reply with EXACTLY one single line in the format: "question :: answer".',
  "Do NOT output any thinking, reasoning, analysis, notes, preamble, drafts, or commentary.",
  "Output ONLY the final single line.",
  `If the thread has no actionable question or resolution to remember, reply with exactly "${DECLINE_MARKER}".`,
].join("\n");

function buildTranscript(messages: ThreadMessage[]): string {
  // Empty Slack messages are omitted so the model sees speaker turns, not blank noise.
  // Empty messages are omitted so the model sees only meaningful conversation turns.
  return messages
    .filter((m) => m.text)
    .map((m) => `${m.bot_id ? "assistant" : "user"}: ${m.text}`)
    .join("\n");
}

function isDeclineLine(line: string): boolean {
  return line.toUpperCase() === DECLINE_MARKER;
}

function parseModelReply(text: string): TeachResult | null {
  const reply = llm.stripThinking((text || "").trim());
  if (!reply || reply.toUpperCase() === DECLINE_MARKER) return null;
  const lines = reply.split("\n").map((l: string) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (isDeclineLine(line)) return null;
    const parsed = learn.parseTeach(line);
    if (!parsed) continue;
    if (/thinking process|analyze user input|format:\s*"/i.test(parsed.question)) continue;
    return parsed;
  }
  return null;
}

async function summarizeThread({ client, channel, threadTs }: { client: ThreadClient; channel: string; threadTs: string }): Promise<TeachResult | null> {
  const { messages } = await client.conversations.replies({ channel, ts: threadTs, limit: THREAD_FETCH_LIMIT });
  const transcript = buildTranscript(messages || []);
  if (!transcript) return null;
  const { text } = await llm.complete(
    {
      baseUrl: answerConfig.baseUrl,
      apiKey: answerConfig.apiKey,
      model: answerConfig.model,
      fallback: answerConfig.fallback,
      onRateLimited: answerConfig.onRateLimited,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    },
    "teach-thread",
  );
  return parseModelReply(text);
}

export = { summarizeThread, buildTranscript, THREAD_FETCH_LIMIT };
