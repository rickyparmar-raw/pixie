const axios = require("axios");
const { config } = require("./config");
const { complete } = require("./llm");
const { normalizeEmoji } = require("./answer");
const log = require("./log");

const MAX_TOKENS = 500;
const TIMEOUT_MS = 30000;
const SLACK_FILE_HOST = "https://files.slack.com/";
const SLACK_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_QUESTION = "can you help with this?";

async function fetchSlackImageAsDataUri(imageUrl: string, slackToken: string | null) {
  const res = await axios.get(imageUrl, {
    headers: { Authorization: `Bearer ${slackToken}` },
    responseType: "arraybuffer",
    timeout: SLACK_FETCH_TIMEOUT_MS,
  });
  const base64 = Buffer.from(res.data, "binary").toString("base64");
  const contentType = res.headers["content-type"] || "image/png";
  return `data:${contentType};base64,${base64}`;
}

function needsSlackFetch(imageUrl: string, slackToken: string | null | undefined) {
  return imageUrl.startsWith(SLACK_FILE_HOST) && !!slackToken;
}

const SKIP = "SKIP";

function visionSystemPrompt(context: string, docs = "") {
  return [
    "You are pixie, a helper in a support channel. Someone shared an image.",
    "Answer their question or fix the problem the image shows, like a friendly human helper would.",
    "Never describe or summarize the image. Don't list what you see.",
    "Keep it to one to three short, casual sentences. Plain words, no headings or bullet lists.",
    "If it's an error, say what's wrong and the fix. If they asked something, answer it.",
    "Program facts (deadlines, rules, prices, how things work) come only from the docs below. Never invent them.",
    `If there's no clear question or problem, or you aren't confident you know the answer, reply with exactly ${SKIP}.`,
    context ? `Conversation so far: ${context}` : "",
    docs ? `Docs:\n${docs}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function analyzeImage(
  imageUrl: string,
  question: string,
  context = "",
  slackToken: string | null = null,
  docs = "",
) {
  let finalImageUrl = imageUrl;
  if (needsSlackFetch(imageUrl, slackToken)) {
    try {
      finalImageUrl = await fetchSlackImageAsDataUri(imageUrl, slackToken);
    } catch (error: unknown) {
      log.error("vision", "failed to fetch Slack image:", error instanceof Error ? error.message : String(error));
      throw new Error("couldn't grab that image from Slack");
    }
  }

  const { text } = await complete(
    {
      baseUrl: config.vision.baseUrl,
      apiKey: config.vision.apiKey,
      model: config.vision.model,
      fallback: config.vision.fallback,
      onRateLimited: config.vision.onRateLimited,
      maxTokens: MAX_TOKENS,
      timeout: TIMEOUT_MS,
      messages: [
        { role: "system", content: visionSystemPrompt(context, docs) },
        {
          role: "user",
          content: [
            { type: "text", text: question || DEFAULT_QUESTION },
            { type: "image_url", image_url: { url: finalImageUrl } },
          ],
        },
      ],
    },
    "vision",
  );

  const reply = text?.trim();
  if (!reply || reply.replace(/[.!\s]/g, "").toUpperCase() === SKIP) return null;
  return normalizeEmoji(reply);
}

export = { analyzeImage, visionSystemPrompt };
