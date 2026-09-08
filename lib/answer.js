// Grounded-answer step: one LLM call that either answers strictly from the
// knowledge corpus or declines. Transport (and retry policy) lives in llm.js.
const { config } = require("./config");
const programs = require("./programs");
const llm = require("./llm");
const brand = require("./brand");

const NONE_MARKER = "NONE";
// "the docs don't cover this" and "I can't tell what this person is even asking
// about" are different failures with different right answers. NONE still gets a
// friendly conversational reply; this one gets no reply at all — see
// lib/respond.js. It's a marker rather than prose because prose has to be
// written into a Slack message before anyone can decide it was worthless.
const UNCLEAR_MARKER = "UNCLEAR";
const MAX_TOKENS = 600;
const DEBUG_MAX_TOKENS = 700;
const FALLBACK_MAX_TOKENS = 900;
const answerFallbackWithHeadroom = config.answer.fallback
  ? { ...config.answer.fallback, maxTokens: FALLBACK_MAX_TOKENS }
  : null;

const CASUAL_EMOJI = ":yay: :hii: :byee: :thumbs-up: :yesyes: :hehehe: :awww: :lets-fucking-gooo: :upvote: :3c: :nyan: :shocked: :loll:";
const UNCLOSED_EMOJI = /:3c(?!:)/g;
const MD_BOLD = /\*\*([^*\n]+)\*\*/g;
const MD_UNDERSCORE_BOLD = /__([^_\n]+)__/g;

function stripChannelMentions(text) {
  if (!text) return "";
  return text
    .replace(/<#[A-Z0-9]+(?:\|[^>]+)?>/gi, "")
    .replace(/#[-a-zA-Z0-9_]+/gi, (m) => (/^#+$/.test(m) ? m : ""))
    .replace(/\s{2,}/g, " ")
    .trim();
}

function linkifyHelpChannel(text, program = null) {
  if (process.env.PIXIE_REQUIRE_GROUNDED_ANSWER === "1" || program?.requireGroundedAnswer) {
    return stripChannelMentions(text);
  }
  const id = (program && program.helpChannel) ? program.helpChannel : config.slack.helpChannel;
  const pattern = /<?#pixl-help>?/gi;
  if (!id) return text;
  return text.replace(pattern, `<#${id}>`);
}

function normalizeEmoji(text, program = null) {
  const normalized = (text || "")
    .replace(UNCLOSED_EMOJI, ":3c:")
    .replace(MD_BOLD, "*$1*")
    .replace(MD_UNDERSCORE_BOLD, "_$1_");

  return linkifyHelpChannel(normalized, program);
}

const CODE_BLOCK = /```[\s\S]*?```|`[^`\n]{12,}`/;
const STACK_TRACE = /\b(?:Traceback \(most recent call last\)|at [\w$.]+\s*\(.*:\d+:\d+\)|[\w.]+Error:|[\w.]+Exception:|SyntaxError|ReferenceError|TypeError|NullPointerException|panic:|segmentation fault)/i;

function looksLikeCode(text) {
  return CODE_BLOCK.test(text || "") || STACK_TRACE.test(text || "");
}

// Callers pass whatever they have — a program object, a bare id string, or
// nothing. They used to be printed straight into the prompt, so a channel could
// be told it belonged to "the pixl program" (the lowercase database id) or "the
// ysws-global program". One place resolves it now, and everything downstream
// works with a real program record or null.
function resolveProgram(program) {
  if (!program) return null;
  if (typeof program === "object") return program;
  try {
    return programs.get(program);
  } catch (e) {
    return null;
  }
}

function programName(program) {
  return resolveProgram(program)?.name || "Pixl";
}

function helpChannelRef(program) {
  const id = resolveProgram(program)?.helpChannel || config.slack.helpChannel;
  return id ? `<#${id}>` : "#pixl-help";
}

function otherProgramNames(current) {
  try {
    return programs
      .all()
      .filter((p) => p.id !== "ysws-global" && (!current || p.id !== current.id))
      .map((p) => p.name)
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// One deployment sits in every YSWS channel at once, which means "the deadline"
// is a different date depending on where it was typed. Nothing in the prompt
// used to say where pixie was — she inferred the program from whichever docs
// happened to be retrieved, and got it wrong whenever the shared docs matched
// first. This is a few lines of prompt and it is the difference between an
// answer and the wrong program's answer.
function whereYouAre(program = null, channel = null) {
  const p = resolveProgram(program);
  const here = channel ? `<#${channel}>` : "a Slack channel";
  const named = p && p.id !== "ysws-global";
  const lines = [];

  if (named) {
    const role = p.helpChannel && p.helpChannel === channel ? "the help channel for" : "one of the channels for";
    lines.push(`WHERE YOU ARE: ${here} — ${role} ${p.name}, a Hack Club YSWS program.`);
    lines.push(
      `Unless somebody names a different program, every question here is about ${p.name}. "the deadline", "the docs", "when does it launch", "how do i submit", "is it out yet" all mean ${p.name}'s.`,
    );
  } else {
    lines.push(`WHERE YOU ARE: ${here} — a channel that isn't tied to any one YSWS program.`);
    lines.push(
      "Don't assume which program someone means. If a question only makes sense for a specific program and they haven't said which one, ask them which.",
    );
  }

  const others = otherProgramNames(p);
  const requireGrounded = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER === "1" || p?.requireGroundedAnswer;
  if (others.length > 0 && !requireGrounded) {
    lines.push(
      `Other Hack Club YSWS programs exist and each has its own docs, deadlines, prizes and rules: ${others.join(", ")}.` +
        ` If somebody here is clearly asking about one of those, say it's a different program and point them at that program's channel.` +
        ` Never answer a question about one program using ${named ? `${p.name}'s` : "another program's"} documentation — the numbers and dates do not carry across.`,
    );
  }

  return lines.join("\n");
}

function programGuardrail(program = null, inHelpChannel = false) {
  const p = resolveProgram(program);
  const name = programName(program);
  const helpChan = helpChannelRef(program);
  const requireGrounded = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER === "1" || p?.requireGroundedAnswer;

  if (requireGrounded) {
    return [
      `HARD RULE: you have documentation for the ${name} program, and it did NOT cover this message.`,
      `You do NOT know the answer. Reply with exactly: SOURCE: NONE and ANSWER: UNCLEAR.`,
      `Never invent a ${name} fact, number, date, or rule. Never guess, and NEVER mention or redirect to any Slack channel.`,
    ].join("\n");
  }

  const redirect = inHelpChannel
    ? `Say you're not sure — a helper in this channel will pick it up. Don't tell them to go to ${helpChan}, they're already here.`
    : `Say you're not sure and point them at ${helpChan}.`;

  return [
    `HARD RULE: you have documentation for the ${name} program, and it did NOT cover this message.`,
    `So if this turns out to be a question about ${name} specifics — deadlines, dates, whether it has launched, prizes, regions, sidequests, restoration energy, rules, how to join, how submissions work — you do NOT know the answer.`,
    `${redirect} Never invent a ${name} fact, number, date, or rule.`,
    `In particular NEVER state or imply whether ${name} has launched, is live, is out, or is still upcoming. You do not know. Saying 'yep it's live' or 'it's not out yet' is equally forbidden — both are guesses.`,
    `For anything that is NOT ${name}-specific — general coding, tools, git, math, life, small talk — just answer normally and helpfully like you would anywhere else.`,
  ].join("\n");
}

function pixlGuardrail(inHelpChannel = false) {
  return programGuardrail("Pixl", inHelpChannel);
}

const PIXL_GUARDRAIL = programGuardrail(null, false);

function timelineAuthorityRule(marker, alwaysLabel = "covered", program = null) {
  const progDesc = `${programName(program)} program itself`;

  return `- If a "Program timeline" section is present, it is the authority ONLY on questions asking specifically whether the ${progDesc} has launched, released, gone live, or about its dates/deadlines — "is it out yet", "when does it drop", "has it launched", "is it released", "how long until launch". Those are ALWAYS ${alwaysLabel} — never answer ${marker} to one, and never contradict it, no matter how it's worded. This does NOT extend to "how do i start/begin doing X" questions about a task, tool, or project (e.g. "how do i start building a PCB") — that "start" means beginning an activity, not asking whether Pixl has launched. The bare word "start" or "begin" alone must never trigger this rule on its own.`;
}

// Prices move when someone restocks and the hours behind them come off a
// stepped payout table, so lib/shop.js works both out in code and answers
// before this prompt is ever built. What reaches the model is the browsing
// case, where every number it needs is already printed next to the item.
function shopAuthorityRule() {
  return (
    '- If a shop section is present it is the only source of reward thresholds, and the hours printed beside an item are the only hours you may give. ' +
    "Never estimate a reward threshold from another item's hours or invent a payout rate. If a requested threshold is not shown, say you'll need to check."
  );
}

const VOICE = [
  "Voice: you talk like a chill teenager texting in Slack, not like customer support copy. Casual, short, contractions, lowercase is fine. Never just reformat the FAQ answer into a stiff formal sentence — say it like a real person quickly typing a reply.",
  "Punctuation: never use dashes. No em dashes, no en dashes, no ' -- '. Where you'd reach for one, use a comma, a full stop, or start a new sentence. Ordinary hyphens inside words and inside commands are fine and must be left alone.",
  `You can sprinkle in these custom Slack emoji where they genuinely fit — use 0-2 per reply, never force one in: ${CASUAL_EMOJI}`,
];

function systemPrompt(corpus, additionalContext = "", program = null, channel = null) {
  const p = resolveProgram(program);
  const requireGrounded = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER === "1" || p?.requireGroundedAnswer;
  const helpChan = helpChannelRef(program);

  const parts = [
    `You are ${brand.name()}, a helper bot for Hack Club's YSWS programs and build guides. You answer questions using ONLY the documentation below.`,
    whereYouAre(program, channel),
    ...VOICE,
    "Rules:",
    `- If the documentation clearly answers the question, reply in this format:\nSOURCE: section name from docs without ### prefix\nANSWER: your short, casual answer in your voice, 1-3 sentences\nOutput only the final answer text after ANSWER:. Never include reasoning, planning, or placeholders.`,
    `- If the documentation does not clearly cover the question, reply with exactly: ${NONE_MARKER}`,
    "- Never guess, speculate, or use outside knowledge. A helper will follow up on anything the docs don't cover.",
    timelineAuthorityRule(NONE_MARKER, "covered", program),
    shopAuthorityRule(),
    "- Match by meaning, not exact wording. Someone can ask a documented question in completely different words — slang, typos, reordered, whatever — and it still counts as a match. 'Strict' means don't answer a genuinely different topic, it does NOT mean the phrasing has to resemble the docs.",
    "- Never copy or lightly reword the doc's own phrasing. Explain it fresh, in your own words, like you already knew the answer off the top of your head — not like you're reciting a lookup result. Two people asking the same thing at different times should not get back the identical sentence.",
    "- NEVER invent approval rules, informal thresholds, or guarantees (e.g. never say 'a short paragraph usually gets it approved' or promise approval). State only the exact criteria explicitly required by the documentation.",
    "- Accurately preserve policy strength: do not turn 'not allowed', 'must disclose', 'isn't allowed', or 'may be flagged' into absolute guarantees like 'you will be rejected' unless the documentation explicitly states that exact consequence.",
    "- DOMAIN SPECIFICITY: When answering a question specifically about software, never include hardware-specific requirements (such as wiring diagrams, PCBs, CAD, schematics, 3D printing, or breadboards). When answering a question specifically about hardware, never include software-only requirements. Keep software and hardware requirements strictly separated.",
    "- STRICT SCENARIO FOCUS: Answer ONLY the specific question asked using the smallest relevant rule. Do NOT blend neighboring paragraphs, adjacent rules, or separate scenarios into a single answer. Never volunteer unrequested policies or neighboring scenarios: for example, if asked whether a returned submission is a penalty or can be resubmitted, answer ONLY about resubmitting returned projects and NEVER mention reduced-hour approvals, payout deductions, or other outcomes unless the user explicitly asked about them.",
    "- RULE HIERARCHY & CONTRADICTION HANDLING: A specific rule always strictly beats a general rule. For example, the specific hardware rule requiring 100% original CAD, 3D models (.step), and PCB designs/schematics (0% AI, no AI allowed) strictly beats any general software AI allowance. When answering about hardware CAD or PCB, never cite or apply the general 30% software code AI allowance.",
    "- 30% AI POLICY: Software and firmware code is capped at a hard ceiling of <=30% AI code, and all AI usage must be honestly disclosed in submission notes and README. Hardware CAD, 3D models, and PCB designs must be 100% original (0% AI). Fully AI-generated projects are strictly prohibited. Exceeding the limit results in project rejection or reduced hours/payout; hiding AI is treated as fraud and leads to rejection and a permanent ban.",
    "- REFERRAL CODES: Referral codes expire in 48 hours (2 days) after being generated.",
    "- Answer the specific question directly without dumping unrelated requirements or volunteering neighboring policies.",
  ];

  if (requireGrounded) {
    parts.push(
      "- STRICT 1:1 GROUNDING: ONLY answer if the documentation explicitly provides the factual answer as confirmed in the documentation. If the docs do not contain the answer, or if the topic is unknown/unconfirmed, you must reply with: " + NONE_MARKER,
      "- NEVER mention, link, or suggest any Slack channels (never use #channel or <#channel>). Never redirect users to other channels.",
      "- Never output non-answers like 'I am not sure', 'I don't know', or suggestions to ask elsewhere.",
    );
  } else {
    parts.push(
      `- If the documentation says to ask for help in #pixl, say ${helpChan} instead — that's the actual dedicated help channel now, the docs text is just outdated on that one detail.`,
    );
  }

  if (additionalContext) {
    parts.push("", additionalContext);
  }

  parts.push("", "=== DOCUMENTATION ===", corpus);
  parts.push(
    "",
    "CRITICAL REMINDER: Stick strictly to the smallest relevant rule directly answering the user's specific scenario. Specific rule beats general rule (hardware CAD/PCB is strictly 0% AI). NEVER blend adjacent rules or volunteer unrequested policies (e.g. do not mention reduced-hour approvals or payout changes when asked about fixing/resubmitting returned submissions).",
  );

  return parts.join("\n");
}

function stripLeadingSafety(text) {
  if (!text) return "";
  let clean = text.trim();
  while (true) {
    const next = clean.replace(
      /^(?:User\s+Safety|Safety\s+Assessment|Safety|Content\s+Filter|Safety\s+Category|Safety\s+Verdict):\s*[^\n]+\s*\n*/i,
      "",
    ).trim();
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

function sanitizeAnswer(text) {
  if (!text) return "";
  let clean = stripLeadingSafety(text);

  clean = clean
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/^[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*$/gi, "")
    .trim();

  clean = clean.replace(/^<(?:a\s+|the\s+|exact\s+)[^>\n]+>\s*/i, "").trim();
  const produceQuotedMatch = clean.match(/(?:let'?s produce|here(?:'s| is) (?:the )?(?:answer|reply)|output|final answer):\s*["“]([\s\S]+?)["”]/i);
  if (produceQuotedMatch) {
    clean = produceQuotedMatch[1].trim();
  } else {
    const produceBlockMatch = clean.match(/(?:let'?s produce|here(?:'s| is) (?:the )?(?:answer|reply)|output|final answer):\s*([\s\S]+?)(?:\n\s*Proceed\.?\s*$|$)/i);
    if (produceBlockMatch && /^(?:we should|we must|i need to|planning)/i.test(clean)) {
      clean = produceBlockMatch[1].trim();
    }
  }

  clean = clean
    .replace(/^(?:your\s+|my\s+)?(?:short,?\s*casual\s+answer|answer\s+in\s+your\s+voice)(?:,?\s*1-3\s+sentences)?[:\s-]*/i, "")
    .trim();

  clean = clean.replace(/\n\s*Proceed\.?\s*$/i, "").trim();

  // Public-output boundary: small models sometimes echo the format
  // instructions or deliberate out loud ("my short, casual answer…", "we need
  // to determine whether the docs cover this…") instead of answering. Any
  // such text must fail closed here — never streamed, never posted.
  if (looksLikeInstructionEcho(clean)) return "";

  return clean;
}

// Fragments of this module's own instruction vocabulary plus task-deliberation
// phrasing. Derived from the prompts above, not from any single incident: any
// model that repeats our format language or narrates its coverage decision is
// malfunctioning, whatever the exact words.
const INSTRUCTION_ECHO_STRONG = [
  "in your voice",
  "1-3 sentences",
  "output only the final answer",
  "never include reasoning",
  "section name from docs",
  "without the ### prefix",
  "output format",
  "my knowledge cutoff",
  "as an ai language model",
  "i don't have access to",
  "thinking process",
  "scratchpad",
  "we need to determine",
  "let's see",
  "does the documentation",
  "the documentation does not specifically",
  "docs structure",
  "section names",
];

const INSTRUCTION_ECHO_WEAK = [
  "short, casual",
  "final answer",
  "planning",
  "documentation below",
  "provided documentation",
  "checking section",
  "the question is about",
  "the question asks",
  "my short",
  "answer in your voice",
];

function looksLikeInstructionEcho(text) {
  const lowered = String(text || "").toLowerCase();
  if (!lowered) return false;
  if (INSTRUCTION_ECHO_STRONG.some((f) => lowered.includes(f))) return true;
  let weak = 0;
  for (const f of INSTRUCTION_ECHO_WEAK) {
    if (lowered.includes(f) && ++weak >= 2) return true;
  }
  return false;
}

function parseReply(raw, program = null) {
  const text = stripLeadingSafety(raw || "").trim();
  if (!text || text === NONE_MARKER) return null;

  const sourceMatch = text.match(/^\s*(?:\*\*)?SOURCE:(?:\*\*)?\s*(.+)$/im);
  const answerMatch = text.match(/^\s*(?:\*\*)?ANSWER:(?:\*\*)?\s*([\s\S]+)$/im);
  if (!answerMatch) return null;

  let rawAnswer = answerMatch[1].trim();
  rawAnswer = rawAnswer
    .replace(/\n\s*SOURCE:\s*(NONE|[^\n]+)/gi, "")
    .replace(/\n\s*ANSWER:\s*/gi, "\n")
    .trim();

  rawAnswer = rawAnswer
    .replace(/^(?:your\s+|my\s+)?(?:short,?\s*casual\s+answer|answer\s+in\s+your\s+voice)(?:,?\s*1-3\s+sentences)?[:\s-]*/i, "")
    .trim();

  // Instruction echo fails closed: a model that repeats the format language
  // instead of answering produces no public output, and the caller escalates.
  if (looksLikeInstructionEcho(rawAnswer)) return null;

  const cleaned = sanitizeAnswer(rawAnswer);
  if (!cleaned || looksLikeInstructionEcho(cleaned)) return null;

  return {
    source: sourceMatch ? sourceMatch[1].trim().replace(/^#+\s*/, "") : null,
    answer: normalizeEmoji(cleaned, program),
  };
}

function answerOrChatPrompt(corpus, additionalContext = "", inHelpChannel = false, program = null, channel = null) {
  const p = resolveProgram(program);
  const name = programName(program);
  const helpChan = helpChannelRef(program);
  const requireGrounded = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER === "1" || p?.requireGroundedAnswer;

  const parts = [
    `You are ${brand.name()}, a helper bot for Hack Club's YSWS programs and build guides.`,
    whereYouAre(program, channel),
    ...VOICE,
  ];

  if (requireGrounded) {
    parts.push(
      "Documentation is below. You must ONLY answer if the documentation directly and factually provides the confirmed answer (1:1 from docs).",
      "",
      "CASE 1 — the documentation factually and directly answers the question. Output format:",
      "SOURCE: section name the answer came from, without the ### prefix",
      "ANSWER: your short, casual answer strictly from the documentation, 1-3 sentences",
      "",
      `CASE 2 — the documentation does NOT directly confirm the answer, or only states that an answer is unknown/unconfirmed/do not invent. Output format:\nSOURCE: ${NONE_MARKER}\nANSWER: ${UNCLEAR_MARKER}`,
      "",
      "Format rules:",
      "- Always emit both lines. Never output a bare answer with no SOURCE line.",
      "- Put ONLY the final answer text immediately after ANSWER: on the same line.",
      "- Output pure answer text only. NEVER output thought process, reasoning, planning, drafts, scratchpad, self-corrections.",
      "- Never echo placeholder text, angle brackets, or formatting instructions.",
      "- NEVER mention, link, or suggest ANY Slack channels (no #channel, no <#channel>). Never redirect users to other channels.",
      "- NEVER output non-answers like 'I'm not sure', 'I don't know', 'there is no confirmed answer', or suggestions to ask in other channels. If you do not have the confirmed answer from docs, always output CASE 2.",
      "",
      "Choosing the case:",
      "- A doc section only counts as CASE 1 if it gives a direct factual answer to what was asked.",
      "- If the docs do not contain the answer, or only describe what not to answer, or say an answer is unconfirmed/unknown, that is CASE 2.",
      timelineAuthorityRule(NONE_MARKER, "CASE 1", program),
      shopAuthorityRule(),
      "- Greetings, small talk, and anything not factually in the docs are CASE 2.",
      "",
      "Writing a CASE 1 answer:",
      "- State the facts directly and accurately from the documentation.",
      "- NEVER mention other channels or suggest asking in other channels.",
      "- NEVER invent approval rules, informal thresholds, or guarantees (e.g. never say 'a short paragraph usually gets it approved' or promise approval). State only the exact criteria explicitly required by the documentation.",
      "- Accurately preserve policy strength: do not turn 'not allowed', 'must disclose', 'isn't allowed', or 'may be flagged' into absolute guarantees like 'you will be rejected' unless the documentation explicitly states that exact consequence.",
      "- DOMAIN SPECIFICITY: When answering a question specifically about software, never include hardware-specific requirements (such as wiring diagrams, PCBs, CAD, schematics, 3D printing, or breadboards). When answering a question specifically about hardware, never include software-only requirements. Keep software and hardware requirements strictly separated.",
      "- STRICT SCENARIO FOCUS: Answer ONLY the specific question asked using the smallest relevant rule. Do NOT blend neighboring paragraphs, adjacent rules, or separate scenarios into a single answer. Never volunteer unrequested policies or neighboring scenarios: for example, if asked whether a returned submission is a penalty or can be resubmitted, answer ONLY about resubmitting returned projects and NEVER mention reduced-hour approvals, payout deductions, or other outcomes unless the user explicitly asked about them.",
      "- RULE HIERARCHY & CONTRADICTION HANDLING: A specific rule always strictly beats a general rule. For example, the specific hardware rule requiring 100% original CAD, 3D models (.step), and PCB designs/schematics (0% AI, no AI allowed) strictly beats any general software AI allowance. When answering about hardware CAD or PCB, never cite or apply the general 30% software code AI allowance.",
      "- 30% AI POLICY: Software and firmware code is capped at a hard ceiling of <=30% AI code, and all AI usage must be honestly disclosed in submission notes and README. Hardware CAD, 3D models, and PCB designs must be 100% original (0% AI). Fully AI-generated projects are strictly prohibited. Exceeding the limit results in project rejection or reduced hours/payout; hiding AI is treated as fraud and leads to rejection and a permanent ban.",
      "- REFERRAL CODES: Referral codes expire in 48 hours (2 days) after being generated.",
      "- Answer the specific question directly without dumping unrelated requirements or volunteering neighboring policies.",
      "",
      "Writing a CASE 2 answer:",
      `Output exactly:\nSOURCE: ${NONE_MARKER}\nANSWER: ${UNCLEAR_MARKER}`,
      programGuardrail(program, inHelpChannel),
    );
  } else {
    parts.push(
      "Documentation is below. Work out which of these two cases you're in, and output that case:",
      "",
      "CASE 1 — the documentation covers the question. Output format:",
      "SOURCE: section name the answer came from, without the ### prefix",
      "ANSWER: your short, casual answer in your voice, 1-3 sentences",
      "",
      `CASE 2 — the documentation does not cover it. Output format:\nSOURCE: ${NONE_MARKER}\nANSWER: your normal, friendly reply, 1-3 sentences`,
      "",
      "Format rules:",
      "- Always emit both lines. Never output a bare answer with no SOURCE line.",
      "- Put ONLY the final answer text immediately after ANSWER: on the same line.",
      "- Output pure answer text only. NEVER output thought process, reasoning, planning, drafts, scratchpad, self-corrections, or words like 'Let's produce' or 'Proceed'.",
      "- Never echo placeholder text, angle brackets, or formatting instructions.",
      "",
      "Choosing the case:",
      "- Match by meaning, not exact wording. Someone can ask a documented question in completely different words — slang, typos, reordered, whatever — and it is still CASE 1. 'Strict' means don't answer a genuinely different topic; it does NOT mean the phrasing has to resemble the docs.",
      `- A message that's clearly asking you to explain, clarify, or expand on something YOU just said in this conversation — 'what do you mean by that', 'wym', 'huh?', 'say more about that' — is about the conversation above, not a fresh lookup. Answer it from what you actually just said, even if the 'About ${brand.name()}' section happens to share a word or two with it (e.g. 'what', 'mean'). Never let a generic identity/FAQ entry hijack a reply to your own previous message — that reads as not knowing what you just said.`,
      "- A doc section only counts as CASE 1 when it is actually ABOUT the subject being asked, not merely because it shares a word or two with the question. 'Commands', 'terminal' and 'install' show up in the git-setup docs, but a question about installing KiCad or any other third-party tool is not a git question just because both mention commands — that's CASE 2. When the conversation above already establishes what's actually being discussed and this message is a follow-up on THAT topic, stay on it rather than jumping to a differently-themed doc entry over incidental vocabulary overlap.",
      "- 'Step by step', 'actual steps', 'list it out', 'give me the exact steps', 'step two now', 'what's step 3', 'next step' and similar describe the FORMAT someone wants the answer in (or which numbered item of THEIR OWN topic they mean), not the subject. Never match a doc section just because it happens to BE a numbered list, and never treat 'step N' as an index into whichever doc section has a step N — a follow-up like 'step by step pls' or 'step two now' after a conversation about cooking chicken means 'give the chicken steps' / 'give step two of the chicken instructions', not 'go find whatever doc has a numbered list and read out its Nth item'. A subject-less follow-up like this always inherits its subject from the immediately preceding exchange in the conversation above, never from whichever doc section happens to share the requested format.",
      `- Installing, configuring or using a piece of software that isn't ${name} itself — an editor, KiCad, Fusion360, git, a package manager, anything — is general tech knowledge, CASE 2, answered like you would answer it anywhere else. It is not a ${name} doc question just because a ${name} doc happens to mention the same tool in passing.`,
      timelineAuthorityRule(NONE_MARKER, "CASE 1", program),
      shopAuthorityRule(),
      "- Greetings, small talk and anything unrelated to the docs are CASE 2.",
      "",
      "Writing a CASE 1 answer:",
      "- Never copy or lightly reword the doc's own phrasing. Explain it fresh, in your own words, like you already knew it off the top of your head — not like you're reciting a lookup result. Two people asking the same thing at different times should not get back the identical sentence.",
      `- If the documentation says to ask for help in #pixl, say ${helpChan} instead — that's the actual dedicated help channel now, the docs text is just outdated on that one detail.`,
      "- NEVER invent approval rules, informal thresholds, or guarantees (e.g. never say 'a short paragraph usually gets it approved' or promise approval). State only the exact criteria explicitly required by the documentation.",
      "- Accurately preserve policy strength: do not turn 'not allowed', 'must disclose', 'isn't allowed', or 'may be flagged' into absolute guarantees like 'you will be rejected' unless the documentation explicitly states that exact consequence.",
      "- DOMAIN SPECIFICITY: When answering a question specifically about software, never include hardware-specific requirements (such as wiring diagrams, PCBs, CAD, schematics, 3D printing, or breadboards). When answering a question specifically about hardware, never include software-only requirements. Keep software and hardware requirements strictly separated.",
      "- STRICT SCENARIO FOCUS: Answer ONLY the specific question asked using the smallest relevant rule. Do NOT blend neighboring paragraphs, adjacent rules, or separate scenarios into a single answer. Never volunteer unrequested policies or neighboring scenarios: for example, if asked whether a returned submission is a penalty or can be resubmitted, answer ONLY about resubmitting returned projects and NEVER mention reduced-hour approvals, payout deductions, or other outcomes unless the user explicitly asked about them.",
      "- RULE HIERARCHY & CONTRADICTION HANDLING: A specific rule always strictly beats a general rule. For example, the specific hardware rule requiring 100% original CAD, 3D models (.step), and PCB designs/schematics (0% AI, no AI allowed) strictly beats any general software AI allowance. When answering about hardware CAD or PCB, never cite or apply the general 30% software code AI allowance.",
      "- 30% AI POLICY: Software and firmware code is capped at a hard ceiling of <=30% AI code, and all AI usage must be honestly disclosed in submission notes and README. Hardware CAD, 3D models, and PCB designs must be 100% original (0% AI). Fully AI-generated projects are strictly prohibited. Exceeding the limit results in project rejection or reduced hours/payout; hiding AI is treated as fraud and leads to rejection and a permanent ban.",
      "- REFERRAL CODES: Referral codes expire in 48 hours (2 days) after being generated.",
      "- Answer the specific question directly without dumping unrelated requirements or volunteering neighboring policies.",
      "",
      "Writing a CASE 2 answer:",
      `- If it's a greeting or small talk ('whats up', 'hey ${brand.name().toLowerCase()}', 'thanks'), match it — one short friendly line back. Don't turn it into a help desk prompt, don't list what you can do, don't ask them to rephrase.`,
      `- If you genuinely cannot tell what they're asking about — the message points at something ('how do i do this', 'is it working yet', 'why wont it') and there is nothing in the conversation above for it to be pointing AT — output exactly:\nSOURCE: ${NONE_MARKER}\nANSWER: ${UNCLEAR_MARKER}\nPixie then says nothing at all, which is the right answer to a message nobody could have answered. Do NOT guess a subject, do NOT ask them what they mean, do NOT list the things you could help with, and do NOT explain how to ask you better. Use this only when the subject is genuinely missing — if you can tell what they mean and simply don't know the answer, that's an ordinary CASE 2 reply.`,
      `- For anything that is NOT ${name}-specific — general coding, tools, git, math, life — just answer normally and helpfully like you would anywhere else.`,
      programGuardrail(program, inHelpChannel),
      "- Don't announce that you checked documentation, and don't apologise for what you don't have. Just talk.",
    );
  }

  if (additionalContext) parts.push("", additionalContext);
  parts.push("", "=== DOCUMENTATION ===", corpus);
  parts.push(
    "",
    "CRITICAL REMINDER: Stick strictly to the smallest relevant rule directly answering the user's specific scenario. Specific rule beats general rule (hardware CAD/PCB is strictly 0% AI). NEVER blend adjacent rules or volunteer unrequested policies (e.g. do not mention reduced-hour approvals or payout changes when asked about fixing/resubmitting returned submissions).",
  );

  return parts.join("\n");
}

const DANGLING_END_WORDS = /\b(?:and|or|but|the|a|an|to|for|with|in|on|at|by|of|from|that|which|who|after|before|because|if|when|as|while|so|than|you|your|their|its|our|my|his|her|this|these|those|is|are|was|were|be|been|have|has|had|will|would|should|could|can|cannot|do|does|did)\s*$/i;
const DANGLING_CONTRACTION = /\b(?:i|you|we|they|he|she|it|that|there|what|who)(?:'ll|'re|'ve|'d|'m|n't)\s*$/i;

function looksTruncated(text) {
  if (!text) return false;
  let trimmed = text.trim();
  if (!trimmed) return false;

  // Unclosed code block: odd number of ```
  const codeBlocks = (trimmed.match(/```/g) || []).length;
  if (codeBlocks % 2 !== 0) return true;

  // Unclosed inline backtick: odd number of `
  const backticks = (trimmed.match(/`/g) || []).length;
  if (backticks % 2 !== 0) return true;

  // Strip trailing Slack emoji (:yay:) or unicode emoji before checking trailing punctuation
  const withoutEmoji = trimmed.replace(/(:[a-z0-9_+-]+:|\p{Emoji_Presentation})\s*$/u, "").trim();

  // Ends on punctuation that expects a continuation: comma, colon, semicolon, dash, slash, open paren/bracket
  if (/[,:;\-–—/(\[{]\s*$/.test(withoutEmoji)) return true;

  // Ends on dangling preposition, conjunction, pronoun, auxiliary verb
  if (DANGLING_END_WORDS.test(trimmed)) return true;
  if (DANGLING_CONTRACTION.test(trimmed)) return true;

  return false;
}

function parseAnswerOrChat(raw, program = null) {
  const text = stripLeadingSafety(raw || "").trim();
  if (!text) return null;

  const parsed = parseReply(text, program);
  if (!parsed) {
    const cleanedText = text
      .replace(/^SOURCE:\s*(NONE|[^\n]+)\n?/i, "")
      .replace(/^ANSWER:\s*/i, "")
      .trim();
    const sanitized = sanitizeAnswer(cleanedText);
    if (!sanitized || looksLikeInstructionEcho(sanitized)) return null;
    return { source: null, answer: normalizeEmoji(sanitized, program) };
  }

  const source = parsed.source;
  const covered = source && source.trim().toUpperCase() !== NONE_MARKER;

  // Matched whole, not by prefix: "unclear on that one, but the deadline is the
  // 18th" is a real answer that happens to start with the same word.
  if (parsed.answer.trim().toUpperCase() === UNCLEAR_MARKER) {
    return { source: null, answer: "", unclear: true };
  }

  return { source: covered ? source : null, answer: parsed.answer };
}

function selectAnswerTier({ isPing = false, inHelpChannel = false } = {}) {
  if (isPing && !inHelpChannel) {
    return config.pingAnswer || config.answer;
  }
  return config.helpAnswer || config.answer;
}

function answerRequest(question, corpus, additionalContext, inHelpChannel = false, program = null, channel = null, { isPing = false } = {}) {
  const tier = selectAnswerTier({ isPing, inHelpChannel });
  const fallbackWithHeadroom = tier.fallback
    ? { ...tier.fallback, maxTokens: FALLBACK_MAX_TOKENS }
    : null;

  return {
    baseUrl: tier.baseUrl,
    apiKey: tier.apiKey,
    model: tier.model,
    fallback: fallbackWithHeadroom,
    onRateLimited: tier.onRateLimited,
    maxTokens: looksLikeCode(question) ? DEBUG_MAX_TOKENS : MAX_TOKENS,
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: answerOrChatPrompt(corpus, additionalContext, inHelpChannel, program, channel) },
      { role: "user", content: question },
    ],
  };
}

async function getAnswerOrChat(question, corpus, additionalContext = "", inHelpChannel = false, program = null, channel = null, { isPing = false } = {}) {
  if (!corpus || !corpus.trim()) return null;

  const req = answerRequest(question, corpus, additionalContext, inHelpChannel, program, channel, { isPing });
  const { text } = await llm.complete(req, "answer");

  const parsed = parseAnswerOrChat(text, program);
  return retryIfTruncated(parsed, req, program);
}

async function getAnswerOrChatStream(question, corpus, additionalContext = "", { onText, inHelpChannel = false, program = null, channel = null, isPing = false } = {}) {
  if (!corpus || !corpus.trim()) return null;

  let sent = "";
  let leakedPlaceholder = false;
  const emit = (_delta, text) => {
    const marker = text.match(/ANSWER:\s*/i);
    if (!marker) {
      if (/^SOURCE:\s*/i.test(text)) return undefined;
      return undefined;
    }

    let answer = text.slice(marker.index + marker[0].length);
    answer = stripLeadingSafety(answer);

    if (leakedPlaceholder || /^<(?:a\s+|the\s+|exact\s+|think|thinking|thought|scratchpad)/i.test(answer.trimStart())) {
      leakedPlaceholder = true;
      const closeIdx = answer.indexOf(">");
      if (closeIdx === -1) return undefined;
      answer = answer.slice(closeIdx + 1).trimStart();
    }

    if (/^(?:we should|we must|planning:|let's produce|let's draft|scratchpad:)/i.test(answer.trimStart())) {
      const produceMatch = answer.match(/(?:let'?s produce|here(?:'s| is) (?:the )?(?:answer|reply)|output|final answer):\s*["“]([\s\S]+?)(?:["”]|$)/i);
      if (produceMatch) {
        answer = produceMatch[1].trimEnd();
      } else {
        return undefined;
      }
    }

    answer = answer
      .replace(/^(?:your\s+|my\s+)?(?:short,?\s*casual\s+answer|answer\s+in\s+your\s+voice)(?:,?\s*1-3\s+sentences)?[:\s-]*/i, "")
      .trimStart();

    if (looksLikeInstructionEcho(answer)) return undefined;

    answer = normalizeEmoji(answer, program).trimEnd();
    // Hold anything that could still turn out to be the "can't tell" marker.
    // Without this the word streams into the placeholder a moment before
    // parsing decides the reply should never have been written at all. Costs a
    // single chunk of latency on a real answer starting with the same letters.
    const upper = answer.toUpperCase();
    if (upper && UNCLEAR_MARKER.startsWith(upper)) return undefined;
    if (answer && answer !== sent) {
      sent = answer;
      if (onText) onText(answer);
    }
    return undefined;
  };

  const req = answerRequest(question, corpus, additionalContext, inHelpChannel, program, channel, { isPing });
  const { text } = await llm.completeStream(
    req,
    emit,
    "answer",
  );

  const parsed = parseAnswerOrChat(text, program);
  return retryIfTruncated(parsed, req, program, { onText });
}

// WHY: one retry policy, not two pasted blocks. A truncated answer means the
// model ran out of tokens mid-sentence; the standby tier gets 900 tokens of
// headroom for exactly one more attempt. Still truncated after that means the
// question genuinely needs more than any reply budget allows, so null (the
// caller escalates) beats posting half a sentence. Streaming callers pass
// onText so the replacement answer still reaches the placeholder.
async function retryIfTruncated(parsed, req, program, { onText = null } = {}) {
  if (!parsed?.answer || !looksTruncated(parsed.answer)) return parsed;
  const fallbackTier = req.fallback || answerFallbackWithHeadroom;
  if (fallbackTier) {
    try {
      const retryRes = await llm.complete({ ...req, ...fallbackTier, maxTokens: FALLBACK_MAX_TOKENS }, "answer");
      const retryParsed = parseAnswerOrChat(retryRes.text, program);
      if (retryParsed?.answer && !looksTruncated(retryParsed.answer)) {
        if (onText) onText(retryParsed.answer);
        return retryParsed;
      }
    } catch (e) {
      log.debug("answer", `fallback retry failed: ${e.message}`);
    }
  }
  if (parsed?.answer && looksTruncated(parsed.answer)) {
    return null;
  }
  return parsed;
}

async function getGroundedAnswer(question, corpus, additionalContext = "", program = null, channel = null, { isPing = false, inHelpChannel = false } = {}) {
  if (!corpus || !corpus.trim()) return null;

  const tier = selectAnswerTier({ isPing, inHelpChannel });
  const fallbackWithHeadroom = tier.fallback
    ? { ...tier.fallback, maxTokens: FALLBACK_MAX_TOKENS }
    : null;

  const { text } = await llm.complete(
    {
      baseUrl: tier.baseUrl,
      apiKey: tier.apiKey,
      model: tier.model,
      fallback: fallbackWithHeadroom,
      onRateLimited: tier.onRateLimited,
      maxTokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: systemPrompt(corpus, additionalContext, program, channel) },
        { role: "user", content: question },
      ],
    },
    "answer",
  );

  return parseReply(text, program);
}

module.exports = {
  getGroundedAnswer,
  getAnswerOrChat,
  getAnswerOrChatStream,
  parseReply,
  parseAnswerOrChat,
  sanitizeAnswer,
  systemPrompt,
  answerOrChatPrompt,
  normalizeEmoji,
  linkifyHelpChannel,
  looksLikeCode,
  NONE_MARKER,
  UNCLEAR_MARKER,
  VOICE,
  CASUAL_EMOJI,
  PIXL_GUARDRAIL,
  MAX_TOKENS,
  DEBUG_MAX_TOKENS,
  pixlGuardrail,
  programGuardrail,
  shopAuthorityRule,
  whereYouAre,
  resolveProgram,
  timelineAuthorityRule,
  stripLeadingSafety,
  looksTruncated,
  retryIfTruncated,
};
