// Turns a Slack thread into a teach entry, triggered by the "Teach Pixie from
// thread" message shortcut (registered in lib/commands.js). Deliberately not a
// slash command: Bolt's SlashCommand payload carries no thread_ts at all, so a
// slash command has no way to know which thread it was typed in. A message
// shortcut's payload does carry the thread, which is why this exists as its
// own trigger instead of an extension of /pixie-teach.
import configModule = require("./config");
import llm = require("./llm");
import learn = require("./learn");
import answer = require("./answer");

const { config } = configModule;
const { MAX_TOKENS } = answer;
const answerConfig = config.answer as typeof config.answer & { onRateLimited?: unknown };

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

// One page of thread history is enough to judge teachability — longer threads
// repeat themselves, and the model call stays bounded.
const THREAD_FETCH_LIMIT = 50;
// The model's only way to say "nothing worth remembering" without parsing risk.
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
  return messages
    .filter((m) => m.text)
    .map((m) => `${m.bot_id ? "assistant" : "user"}: ${m.text}`)
    .join("\n");
}

function isDeclineLine(line: string): boolean {
  return line.toUpperCase() === DECLINE_MARKER;
}

// Model thinking leaks back in as preamble — only a trailing parseable Q&A
// line counts, and leaked prompt echoes never do.
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

// Returns { question, answer } or null — either the thread had nothing worth
// teaching, or the model declined, or its reply didn't parse.
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
