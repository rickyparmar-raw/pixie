// Vision analysis for screenshots, mockups, and error images.
// Routes through OpenCode Zen's vision endpoint when available.
const axios = require("axios");

const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const VISION_MODEL = "kr/claude-sonnet-4.5";

async function analyzeImage(imageUrl, question, context = "", slackToken = null) {
  // If it's a Slack private URL, fetch it with auth and convert to base64
  let finalImageUrl = imageUrl;
  if (imageUrl.startsWith("https://files.slack.com/") && slackToken) {
    try {
      const imageResponse = await axios.get(imageUrl, {
        headers: { Authorization: `Bearer ${slackToken}` },
        responseType: "arraybuffer",
        timeout: 10000,
      });
      const base64 = Buffer.from(imageResponse.data, "binary").toString("base64");
      const contentType = imageResponse.headers["content-type"] || "image/png";
      finalImageUrl = `data:${contentType};base64,${base64}`;
    } catch (e) {
      console.error("[pixie/vision] failed to fetch Slack image:", e.message);
      throw new Error("couldn't grab that image from Slack");
    }
  }

  const messages = [
    {
      role: "system",
      content: [
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
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: [
        { type: "text", text: question || "what am i looking at here?" },
        { type: "image_url", image_url: { url: finalImageUrl } },
      ],
    },
  ];

  const baseUrl = process.env.OPENCODE_BASE_URL || DEFAULT_BASE_URL;
  const endpoint = `${baseUrl}/chat/completions`;

  const res = await axios.post(
    endpoint,
    {
      model: process.env.PIXIE_VISION_MODEL || VISION_MODEL,
      max_tokens: 500,
      messages,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.VISION_API_KEY || process.env.OPENCODE_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
  );

  return res.data?.choices?.[0]?.message?.content?.trim() || null;
}

module.exports = { analyzeImage };
