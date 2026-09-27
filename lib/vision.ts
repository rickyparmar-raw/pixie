const axios = require("axios");
const { config } = require("./config");
const { complete } = require("./llm");
const { normalizeEmoji } = require("./answer");
const log = require("./log");

const MAX_TOKENS = 500;
const TIMEOUT_MS = 30000;
const SLACK_FILE_HOST = "https://files.slack.com/";
const SLACK_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_QUESTION = "what am i looking at here?";

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

function visionSystemPrompt(context: string) {
  return [
    "You are pixie, helping debug code and answer questions about images.",
    "Be direct and clear. Skip filler phrases like 'this looks like' or 'it appears to be'.",
    "Start with the answer immediately. Use short sentences.",
    "IMPORTANT: Only describe what you can actually see in the image. Don't guess or assume functionality.",
    "If you can't tell exactly what something does from the visual alone, say what's visible without speculating.",
    "For UI screenshots: describe the elements you see, not what you think they do unless it's explicitly labeled.",
    "If it's an error screenshot, say what's wrong and how to fix it.",
    "If it's a design mockup, say how to build it.",
    "If it's pixel art, give technique feedback.",
    "Use casual tone but stay concise — like explaining to a friend who's in a hurry.",
    context ? `Context: ${context}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function analyzeImage(imageUrl: string, question: string, context = "", slackToken: string | null = null) {
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
        { role: "system", content: visionSystemPrompt(context) },
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
  return reply ? normalizeEmoji(reply) : null;
}

export = { analyzeImage, visionSystemPrompt };
