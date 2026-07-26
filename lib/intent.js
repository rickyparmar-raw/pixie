const axios = require("axios");

const DEFAULT_MODEL = "deepseek-v4-flash-free";
const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const MAX_TOKENS = 20; // minimal tokens for binary classification
const HELP_NEEDED = "HELP_NEEDED";
const CASUAL_CHAT = "CASUAL_CHAT";

function intentSystemPrompt() {
  return `You are a binary intent classifier for a Slack channel about Pixl (a game/program for Hack Clubbers).
Your job: decide if a message needs help/answer or is just casual chat.

CRITICAL: Only classify as HELP_NEEDED if the question is related to:
- Pixl (the game/program itself)
- Game development, coding, projects, building things
- Technical setup (git, github, hackatime, etc)
- Math questions or calculations

Questions about completely unrelated topics should be CASUAL_CHAT.

Reply with EXACTLY one of these:
- HELP_NEEDED: Pixl-related, coding-related, math-related question that needs an answer
- CASUAL_CHAT: casual statement, reaction, greeting, OR any off-topic question

Be strict: when in doubt about relevance, choose CASUAL_CHAT.`;
}

async function classifyIntent(message) {
  if (!message || message.length < 5) return CASUAL_CHAT;

  const apiKey = process.env.INTENT_CLASSIFIER_API_KEY;
  const model = process.env.INTENT_CLASSIFIER_MODEL || DEFAULT_MODEL;
  const baseUrl = process.env.INTENT_CLASSIFIER_BASE_URL || DEFAULT_BASE_URL;

  if (!apiKey) {
    console.error("[pixie/intent] INTENT_CLASSIFIER_API_KEY not set");
    return null;
  }

  try {
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: intentSystemPrompt() },
          { role: "user", content: message },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    const text = res.data?.choices?.[0]?.message?.content?.trim();
    // Check if response starts with the expected label (model may add extra text)
    if (text?.startsWith(HELP_NEEDED)) return HELP_NEEDED;
    if (text?.startsWith(CASUAL_CHAT)) return CASUAL_CHAT;
    return null;
  } catch (e) {
    console.error("[pixie/intent] classification failed:", e.message);
    return null;
  }
}

module.exports = { classifyIntent, HELP_NEEDED, CASUAL_CHAT };
