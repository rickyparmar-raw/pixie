// Grounded-answer step: one LLM call that either answers strictly from the
// knowledge corpus or declines. Routed through OpenCode Zen's OpenAI-compatible
// chat completions endpoint (https://opencode.ai/zen/v1/chat/completions).
const axios = require("axios");

const DEFAULT_MODEL = "deepseek-v4-flash-free";
const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const NONE_MARKER = "NONE";

const CASUAL_EMOJI = ":yay: :hii: :byee: :thumbs-up: :yesyes: :hehehe: :awww: :lets-fucking-gooo: :upvote: :3c: :nyan: :shocked: :loll:";

function systemPrompt(corpus, additionalContext = "") {
  const parts = [
    "You are pixie, a Slack bot for the Pixl program's help channel. You answer questions using ONLY the documentation below.",
    "Voice: you talk like a chill teenager texting in Slack, not like customer support copy. Casual, short, contractions, lowercase is fine. Never just reformat the FAQ answer into a stiff formal sentence — say it like a real person quickly typing a reply.",
    `You can sprinkle in these custom Slack emoji where they genuinely fit — use 0-2 per reply, never force one in: ${CASUAL_EMOJI}`,
    "Rules:",
    `- If the documentation clearly answers the question, reply in exactly this format:\nSOURCE: <the section name the answer came from, without the ### prefix>\nANSWER: <a short, casual answer in pixie's voice, 1-3 sentences>`,
    `- If the documentation does not clearly cover the question, reply with exactly: ${NONE_MARKER}`,
    "- Never guess, speculate, or use outside knowledge. A helper will follow up on anything the docs don't cover.",
    "- Match by meaning, not exact wording. Someone can ask a documented question in completely different words — slang, typos, reordered, whatever — and it still counts as a match. 'Strict' means don't answer a genuinely different topic, it does NOT mean the phrasing has to resemble the docs.",
    "- Never copy or lightly reword the doc's own phrasing. Explain it fresh, in your own words, like you already knew the answer off the top of your head — not like you're reciting a lookup result. Two people asking the same thing at different times should not get back the identical sentence.",
    "- If the documentation says to ask for help in #pixl, say #pixl-help instead — that's the actual dedicated help channel now, the docs text is just outdated on that one detail.",
    "- EXCEPTION: When someone asks 'what is Pixl?', 'tell me about Pixl', 'explain Pixl', or similar broad intro questions, give the FULL story in a longer answer (5-8 sentences). Combine info from BOTH the FAQ's 'why is it called Pixl' answer AND the docs' Welcome section. Include: Origin civilization, the Great Static breaking it apart, Hack Clubbers helping rebuild it into Pixl, how you repair the world by shipping real projects for NPCs, Restoration Energy, earning pixels + real prizes, and how chapters unlock new regions. Cite the source as 'Welcome to Pixl' or 'Pixl FAQ'. This is the ONE question where comprehensive > brief.",
  ];

  if (additionalContext) {
    parts.push("", additionalContext);
  }

  parts.push("", "=== DOCUMENTATION ===", corpus);

  return parts.join("\n");
}

function parseReply(raw) {
  const text = (raw || "").trim();
  if (!text || text === NONE_MARKER) return null;

  const sourceMatch = text.match(/^SOURCE:\s*(.+)$/m);
  const answerMatch = text.match(/^ANSWER:\s*([\s\S]+)$/m);
  if (!answerMatch) return null;

  return {
    source: sourceMatch ? sourceMatch[1].trim().replace(/^#+\s*/, "") : null,
    answer: answerMatch[1].trim(),
  };
}

const MAX_TOKENS = 300;

async function requestCompletion(question, corpus, additionalContext = "") {
  // Always use OpenCode Zen for text answers (vision uses separate local endpoint)
  const endpoint = "https://opencode.ai/zen/v1/chat/completions";

  const res = await axios.post(
    endpoint,
    {
      model: process.env.PIXIE_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      // Disables deepseek's reasoning/"thinking" phase — cuts latency by
      // roughly 4x (measured ~10s -> ~2.5s) and eliminates the empty-
      // completion failure mode caused by it burning the whole token
      // budget on invisible reasoning tokens. OpenCode Zen honors this
      // DeepSeek-native param even though it's undocumented on Zen's side.
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: systemPrompt(corpus, additionalContext) },
        { role: "user", content: question },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENCODE_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 25000,
    },
  );

  return {
    text: res.data?.choices?.[0]?.message?.content,
    finishReason: res.data?.choices?.[0]?.finish_reason,
  };
}

const MAX_ATTEMPTS = 3;

// Returns { source, answer } if the corpus covers the question, or null if
// pixie should stay silent (passive path) / show the fallback (mention path).
//
// deepseek-v4-flash-free is a reasoning model that sometimes burns its whole
// token budget on invisible "thinking" tokens before writing anything visible,
// coming back empty with finish_reason "length" — retry (non-deterministic,
// so a fresh attempt often succeeds) rather than spending real money on a
// paid model just for this free tier's inconsistency.
async function getGroundedAnswer(question, corpus, additionalContext = "") {
  if (!corpus || !corpus.trim()) return null;

  let text = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await requestCompletion(question, corpus, additionalContext);
    text = result.text;
    if (text?.trim() || result.finishReason !== "length") break;
  }

  return parseReply(text);
}

module.exports = { getGroundedAnswer, parseReply, systemPrompt, NONE_MARKER };
