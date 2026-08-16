// Grounded-answer step: one LLM call that either answers strictly from the
// knowledge corpus or declines. Transport (and retry policy) lives in llm.js.
const { config } = require("./config");
// Module object rather than a destructured `complete`: destructuring binds at
// load time, which makes the transport impossible to stub. Same reason
// lib/respond.js holds lib/answer.js this way.
const llm = require("./llm");

const NONE_MARKER = "NONE";
const MAX_TOKENS = 300;
// A pasted stack trace needs room for a corrected snippet; a greeting doesn't.
const DEBUG_MAX_TOKENS = 700;

// Gemini via the 9Router fallback needs more headroom than deepseek's 300 —
// and unlike the non-streaming path, getAnswerOrChatStream's streaming call
// has no finish_reason check at all, so a stream that hits the cap just ends
// mid-sentence with no error and nothing to retry. Wider budget beats a
// silently truncated reply.
const FALLBACK_MAX_TOKENS = 900;
const answerFallbackWithHeadroom = config.answer.fallback
  ? { ...config.answer.fallback, maxTokens: FALLBACK_MAX_TOKENS }
  : null;

const CASUAL_EMOJI = ":yay: :hii: :byee: :thumbs-up: :yesyes: :hehehe: :awww: :lets-fucking-gooo: :upvote: :3c: :nyan: :shocked: :loll:";

// The model reliably drops the closing colon on `:3c:` — it reads as a kaomoji
// so it writes `:3c`, which Slack renders as literal text instead of the
// emoji. Repair it on the way out rather than fighting the prompt.
const UNCLOSED_EMOJI = /:3c(?!:)/g;

// Slack mrkdwn is not Markdown: bold is *one* asterisk, so a model writing
// **bold** renders the asterisks literally. Same for __underline__.
const MD_BOLD = /\*\*([^*\n]+)\*\*/g;
const MD_UNDERSCORE_BOLD = /__([^_\n]+)__/g;

// Slack only renders a channel in blue when it's written as <#ID>. A bare
// `#pixl-help` is plain text — and the docs, the FAQ and lib/identity.js all
// use the bare form, so the model copies it no matter what the prompt says.
// Rewrite it on the way out, same as the emoji above. `<#pixl-help>` is the
// model's other guess at the syntax; an already-correct <#C…> can't match.
const BARE_HELP_CHANNEL = /<?#pixl-help>?/gi;

function linkifyHelpChannel(text) {
  const id = config.slack.helpChannel;
  return id ? text.replace(BARE_HELP_CHANNEL, `<#${id}>`) : text;
}

function normalizeEmoji(text) {
  const normalized = (text || "")
    .replace(UNCLOSED_EMOJI, ":3c:")
    .replace(MD_BOLD, "*$1*")
    .replace(MD_UNDERSCORE_BOLD, "_$1_");

  return linkifyHelpChannel(normalized);
}

// Fenced block, indented block, or something that reads like a stack trace.
// Lives here rather than in chat.js because both the merged prompt below and
// the standalone chat path size their token budget off it.
const CODE_BLOCK = /```[\s\S]*?```|`[^`\n]{12,}`/;
const STACK_TRACE = /\b(?:Traceback \(most recent call last\)|at [\w$.]+\s*\(.*:\d+:\d+\)|[\w.]+Error:|[\w.]+Exception:|SyntaxError|ReferenceError|TypeError|NullPointerException|panic:|segmentation fault)/i;

function looksLikeCode(text) {
  return CODE_BLOCK.test(text || "") || STACK_TRACE.test(text || "");
}

// The one rule that must survive anywhere pixie speaks without the corpus
// backing it. Shared by the merged prompt and lib/chat.js.
//
// The redirect line has to know whether pixie is already IN #pixl-help —
// otherwise it tells someone reading #pixl-help right now to go ask in
// #pixl-help, which reads as pixie not knowing what channel it's in.
function pixlGuardrail(inHelpChannel = false) {
  const redirect = inHelpChannel
    ? "Say you're not sure — a helper in this channel will pick it up. Don't tell them to go to #pixl-help, they're already here."
    : "Say you're not sure and point them at #pixl-help.";

  return [
    "HARD RULE: you have documentation for the Pixl program, and it did NOT cover this message.",
    "So if this turns out to be a question about Pixl specifics — deadlines, dates, whether it has launched, prizes, regions, sidequests, restoration energy, rules, how to join, how submissions work — you do NOT know the answer.",
    `${redirect} Never invent a Pixl fact, number, date, or rule.`,
    "In particular NEVER state or imply whether Pixl has launched, is live, is out, or is still upcoming. You do not know. Saying 'yep it's live' or 'it's not out yet' is equally forbidden — both are guesses.",
    "For anything that is NOT Pixl-specific — general coding, tools, git, math, life, small talk — just answer normally and helpfully like you would anywhere else.",
  ].join("\n");
}

// Backward-compatible default (the "not currently in the help channel" copy)
// for the few call sites that don't thread channel context through yet.
const PIXL_GUARDRAIL = pixlGuardrail(false);

// "no matter how the question is worded" used to have no boundary at all, so
// a bare "start" was enough to hijack an unrelated question — live example:
// "how do i start pcb, what is pcb and schematics" got answered with the
// launch date, because "start" reads like "has it started" with nothing to
// tell the model those aren't the same thing. Shared by both prompt builders
// below so the boundary can't drift out of sync between them.
function timelineAuthorityRule(marker, alwaysLabel = "covered") {
  return `- If a "Program timeline" section is present, it is the authority ONLY on questions asking specifically whether the PIXL PROGRAM ITSELF has launched, released, gone live, or about its dates/deadlines — "is it out yet", "when does it drop", "has it launched", "is it released", "how long until launch". Those are ALWAYS ${alwaysLabel} — never answer ${marker} to one, and never contradict it, no matter how it's worded. This does NOT extend to "how do i start/begin doing X" questions about a task, tool, or project (e.g. "how do i start building a PCB") — that "start" means beginning an activity, not asking whether Pixl has launched. The bare word "start" or "begin" alone must never trigger this rule on its own.`;
}

// Shared with lib/chat.js so pixie sounds like one bot across both paths.
const VOICE = [
  "Voice: you talk like a chill teenager texting in Slack, not like customer support copy. Casual, short, contractions, lowercase is fine. Never just reformat the FAQ answer into a stiff formal sentence — say it like a real person quickly typing a reply.",
  `You can sprinkle in these custom Slack emoji where they genuinely fit — use 0-2 per reply, never force one in: ${CASUAL_EMOJI}`,
];

function systemPrompt(corpus, additionalContext = "") {
  const parts = [
    "You are pixie, a Slack bot for the Pixl program's help channel. You answer questions using ONLY the documentation below.",
    ...VOICE,
    "Rules:",
    `- If the documentation clearly answers the question, reply in exactly this format:\nSOURCE: <the section name the answer came from, without the ### prefix>\nANSWER: <a short, casual answer in pixie's voice, 1-3 sentences>`,
    `- If the documentation does not clearly cover the question, reply with exactly: ${NONE_MARKER}`,
    "- Never guess, speculate, or use outside knowledge. A helper will follow up on anything the docs don't cover.",
    timelineAuthorityRule(NONE_MARKER),
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

  let rawAnswer = answerMatch[1].trim();
  // If the model produced multiple SOURCE/ANSWER blocks (e.g. multi-question prompt),
  // strip internal SOURCE: / ANSWER: lines so they don't leak into the final Slack output.
  rawAnswer = rawAnswer
    .replace(/\n\s*SOURCE:\s*(NONE|[^\n]+)/gi, "")
    .replace(/\n\s*ANSWER:\s*/gi, "\n")
    .trim();

  return {
    source: sourceMatch ? sourceMatch[1].trim().replace(/^#+\s*/, "") : null,
    answer: normalizeEmoji(rawAnswer),
  };
}

/* ------------------------------------------------- merged answer-or-chat -- */

// The mention path used to cost two sequential model calls: ask the corpus, get
// NONE, then ask again conversationally. At ~1.5s of fixed overhead per call
// that was the single biggest chunk of pixie's latency — measured 5615ms
// average on the path that 48% of traffic takes.
//
// One call does both. The corpus is nearly free to carry (7.4k tokens of
// prefill measured at ~0.5s), so the only thing the second call ever bought was
// the decision, and the model can make that decision inline.
function answerOrChatPrompt(corpus, additionalContext = "", inHelpChannel = false) {
  const parts = ["You are pixie, a Slack bot for the Hack Club Pixl program's channels.", ...VOICE];

  parts.push(
    "Documentation is below. Work out which of these two cases you're in, and output ONLY that case:",
    "",
    "CASE 1 — the documentation covers the question. Output exactly:",
    "SOURCE: <the section name the answer came from, without the ### prefix>",
    "ANSWER: <a short, casual answer in pixie's voice, 1-3 sentences>",
    "",
    `CASE 2 — the documentation does not cover it. Output exactly:\nSOURCE: ${NONE_MARKER}\nANSWER: <a normal, friendly reply, 1-3 sentences>`,
    "",
    "Always emit both lines. Never output a bare answer with no SOURCE line.",
    "",
    "Choosing the case:",
    "- Match by meaning, not exact wording. Someone can ask a documented question in completely different words — slang, typos, reordered, whatever — and it is still CASE 1. 'Strict' means don't answer a genuinely different topic; it does NOT mean the phrasing has to resemble the docs.",
    "- A message that's clearly asking you to explain, clarify, or expand on something YOU just said in this conversation — 'what do you mean by that', 'wym', 'huh?', 'say more about that' — is about the conversation above, not a fresh lookup. Answer it from what you actually just said, even if the 'About pixie' section happens to share a word or two with it (e.g. 'what', 'mean'). Never let a generic identity/FAQ entry hijack a reply to your own previous message — that reads as not knowing what you just said.",
    "- A doc section only counts as CASE 1 when it is actually ABOUT the subject being asked, not merely because it shares a word or two with the question. 'Commands', 'terminal' and 'install' show up in the git-setup docs, but a question about installing KiCad or any other third-party tool is not a git question just because both mention commands — that's CASE 2. When the conversation above already establishes what's actually being discussed and this message is a follow-up on THAT topic, stay on it rather than jumping to a differently-themed doc entry over incidental vocabulary overlap.",
    "- 'Step by step', 'actual steps', 'list it out', 'give me the exact steps', 'step two now', 'what's step 3', 'next step' and similar describe the FORMAT someone wants the answer in (or which numbered item of THEIR OWN topic they mean), not the subject. Never match a doc section just because it happens to BE a numbered list, and never treat 'step N' as an index into whichever doc section has a step N — a follow-up like 'step by step pls' or 'step two now' after a conversation about cooking chicken means 'give the chicken steps' / 'give step two of the chicken instructions', not 'go find whatever doc has a numbered list and read out its Nth item'. A subject-less follow-up like this always inherits its subject from the immediately preceding exchange in the conversation above, never from whichever doc section happens to share the requested format.",
    "- Installing, configuring or using a piece of software that isn't Pixl itself — an editor, KiCad, Fusion360, git, a package manager, anything — is general tech knowledge, CASE 2, answered like you would answer it anywhere else. It is not a Pixl doc question just because a Pixl doc happens to mention the same tool in passing.",
    timelineAuthorityRule(NONE_MARKER, "CASE 1"),
    "- Greetings, small talk and anything unrelated to the docs are CASE 2.",
    "",
    "Writing a CASE 1 answer:",
    "- Never copy or lightly reword the doc's own phrasing. Explain it fresh, in your own words, like you already knew it off the top of your head — not like you're reciting a lookup result. Two people asking the same thing at different times should not get back the identical sentence.",
    "- If the documentation says to ask for help in #pixl, say #pixl-help instead — that's the actual dedicated help channel now, the docs text is just outdated on that one detail.",
    "- EXCEPTION: When someone asks 'what is Pixl?', 'tell me about Pixl', 'explain Pixl', or similar broad intro questions, give the FULL story in a longer answer (5-8 sentences). Combine info from BOTH the FAQ's 'why is it called Pixl' answer AND the docs' Welcome section. Include: Origin civilization, the Great Static breaking it apart, Hack Clubbers helping rebuild it into Pixl, how you repair the world by shipping real projects for NPCs, Restoration Energy, earning pixels + real prizes, and how chapters unlock new regions. Cite the source as 'Welcome to Pixl' or 'Pixl FAQ'. This is the ONE question where comprehensive > brief.",
    "",
    "Writing a CASE 2 answer:",
    "- If it's a greeting or small talk ('whats up', 'hey pixie', 'thanks'), match it — one short friendly line back. Don't turn it into a help desk prompt, don't list what you can do, don't ask them to rephrase.",
    "- For anything that is NOT Pixl-specific — general coding, tools, git, math, life — just answer normally and helpfully like you would anywhere else.",
    pixlGuardrail(inHelpChannel),
    "- Don't announce that you checked documentation, and don't apologise for what you don't have. Just talk.",
  );

  if (additionalContext) parts.push("", additionalContext);
  parts.push("", "=== DOCUMENTATION ===", corpus);

  return parts.join("\n");
}

// Returns { source, answer } where a null `source` means the docs didn't cover
// it — the caller treats that exactly like the old NONE: record a gap, flag for
// humans, don't cache. Returns null only when the model gave us nothing usable.
//
// Three response shapes come back in practice, all seen against the live model:
//   SOURCE: Pixl FAQ / ANSWER: ...   -> grounded
//   SOURCE: NONE     / ANSWER: ...   -> conversational
//   bare prose, no prefix at all     -> conversational (greetings do this)
function parseAnswerOrChat(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  const parsed = parseReply(text);
  // No SOURCE/ANSWER structure at all. Greetings come back as plain prose, and
  // dropping them would send a perfectly good reply to the fallback.
  if (!parsed) {
    const cleanedText = text
      .replace(/^SOURCE:\s*(NONE|[^\n]+)\n?/i, "")
      .replace(/^ANSWER:\s*/i, "")
      .trim();
    return { source: null, answer: normalizeEmoji(cleanedText) };
  }

  const source = parsed.source;
  const covered = source && source.trim().toUpperCase() !== NONE_MARKER;
  return { source: covered ? source : null, answer: parsed.answer };
}

// Shared by the streamed and non-streamed calls so they can never drift on
// model, token budget or the thinking flag.
function answerRequest(question, corpus, additionalContext, inHelpChannel = false) {
  return {
    baseUrl: config.answer.baseUrl,
    apiKey: config.answer.apiKey,
    model: config.answer.model,
    fallback: answerFallbackWithHeadroom,
    onRateLimited: config.answer.onRateLimited,
    maxTokens: looksLikeCode(question) ? DEBUG_MAX_TOKENS : MAX_TOKENS,
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: answerOrChatPrompt(corpus, additionalContext, inHelpChannel) },
      { role: "user", content: question },
    ],
  };
}

async function getAnswerOrChat(question, corpus, additionalContext = "", inHelpChannel = false) {
  if (!corpus || !corpus.trim()) return null;

  const { text } = await llm.complete(answerRequest(question, corpus, additionalContext, inHelpChannel), "answer");

  return parseAnswerOrChat(text);
}

// Streamed twin of getAnswerOrChat. `onText` receives the answer *so far* —
// the whole string, not the delta — because that is what chat.update needs and
// because normalizeEmoji's repairs span token boundaries.
//
// The model writes SOURCE: before ANSWER:, so nothing is forwarded until the
// ANSWER: marker arrives — measured ~1.7s, ~200ms after the first token.
async function getAnswerOrChatStream(question, corpus, additionalContext = "", { onText, inHelpChannel = false } = {}) {
  if (!corpus || !corpus.trim()) return null;

  let sent = "";
  const emit = (_delta, text) => {
    // Wait until ANSWER: marker lands so raw SOURCE: headers aren't streamed
    const marker = text.match(/ANSWER:\s*/i);
    if (!marker) {
      // If text starts with SOURCE: NONE without an ANSWER: marker yet, do not emit until ANSWER: appears
      if (/^SOURCE:\s*/i.test(text)) return undefined;
      return undefined;
    }

    const answer = normalizeEmoji(text.slice(marker.index + marker[0].length)).trimEnd();
    if (answer && answer !== sent) {
      sent = answer;
      if (onText) onText(answer);
    }
    return undefined;
  };

  const { text } = await llm.completeStream(
    answerRequest(question, corpus, additionalContext, inHelpChannel),
    emit,
    "answer",
  );

  return parseAnswerOrChat(text);
}

// Returns { source, answer } if the corpus covers the question, or null if
// pixie should stay silent (passive path) / hand off to chat.js (mention path).
async function getGroundedAnswer(question, corpus, additionalContext = "") {
  if (!corpus || !corpus.trim()) return null;

  const { text } = await llm.complete(
    {
      baseUrl: config.answer.baseUrl,
      apiKey: config.answer.apiKey,
      model: config.answer.model,
      fallback: answerFallbackWithHeadroom,
      onRateLimited: config.answer.onRateLimited,
      maxTokens: MAX_TOKENS,
      // Disables deepseek's reasoning/"thinking" phase — cuts latency by
      // roughly 4x (measured ~10s -> ~2.5s) and eliminates the empty-
      // completion failure mode caused by it burning the whole token budget on
      // invisible reasoning tokens. OpenCode Zen honors this DeepSeek-native
      // param even though it's undocumented on Zen's side.
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: systemPrompt(corpus, additionalContext) },
        { role: "user", content: question },
      ],
    },
    "answer",
  );

  return parseReply(text);
}

module.exports = {
  getGroundedAnswer,
  getAnswerOrChat,
  getAnswerOrChatStream,
  parseReply,
  parseAnswerOrChat,
  systemPrompt,
  answerOrChatPrompt,
  normalizeEmoji,
  linkifyHelpChannel,
  looksLikeCode,
  NONE_MARKER,
  VOICE,
  CASUAL_EMOJI,
  PIXL_GUARDRAIL,
  MAX_TOKENS,
  DEBUG_MAX_TOKENS,
  pixlGuardrail,
  timelineAuthorityRule,
};
