// Central reply-eligibility: WHEN Pixie may speak publicly. One authoritative
// decision point consulted before any public AI response is generated.
//
// Pure and deterministic: all thread state is passed in, nothing is read from
// the database here, and no usernames are special-cased (humans are
// "another mention" or "deferral verbs", never an identity list). Model
// verdicts (intent) and retrieval outcomes (grounding) stay downstream — this
// layer decides on routing-level signals only, so obvious silence costs no
// model call and obvious danger never waits for one.
//
// Scope: ambient event-driven speech (channel messages, thread replies,
// mentions, reactions that post). Explicit slash commands are deliberate
// addressed actions and stay outside this gate, as do copilot/internal reads.
// The command bypass below means "let the command handler decide", not "reply".
//
// Decisions: REPLY | SILENT | ESCALATE | HUMAN_DEFER. Reasons are
// machine-readable; no chain-of-thought leaves this module. Side-effect
// requests (markTakeover, clearMute, touchTicket, fileTicket) are returned as
// flags — callers perform them, keeping this module free of I/O.
const REPLY = "reply";
const SILENT = "silent";
const ESCALATE = "escalate";
const HUMAN_DEFER = "human_defer";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function botNamePattern(botNames) {
  const names = [...new Set((botNames || []).filter(Boolean))].map(escapeRegex).join("|");
  return names || "pixie";
}

// All <@U…> mentions that are not the bot itself.
function otherMentions(text, botUserId) {
  const found = String(text || "").match(/<@[A-Z0-9]+(?:\|[^>]+)?>/g) || [];
  return found.filter((m) => !botUserId || !m.includes(botUserId));
}

function directMention(text, botUserId) {
  return !!botUserId && String(text || "").includes(`<@${botUserId}>`);
}

function nameMentionAt(text, names) {
  const m = String(text || "").match(new RegExp(`\\b(?:${botNamePattern(names)})\\w*\\b`, "i"));
  return m ? { token: m[0], index: m.index } : null;
}

// Invocation ("@Pixie how does RE work?") vs reference ("ask @Pixie next
// time", "Pixie already answered", "@Ricky Pixie said…"). Sentence-initial
// address is always an invocation; otherwise a nearby request verb invokes
// while referential verbs silence. Ambiguous mentions invoke — same as today.
function invocationAnalysis(text, { botUserId = null, botNames = [] } = {}) {
  const body = String(text || "");
  const mentioned = directMention(body, botUserId);
  const named = nameMentionAt(body, botNames);
  if (!mentioned && !named) return { addressed: false, invocation: false, referential: false };

  const stripped = body.replace(/^[\s,.;:!?-]+/, "");
  // Referential use outranks position: "Pixie said…" at sentence start still
  // reports speech rather than summoning.
  const referential = /\b(ask|tell|ping|invite|thank|thanks|replace|blame|ignore|listen to)\b[^.!?]{0,40}(?:\bpixie|<@)/i.test(body)
    || /\bpixie\w*\s+(already\s+)?(said|answered|replied|replies|thinks?|knows?|told)\b/i.test(body)
    || /\breplace\s+\S+\s+with\s+(?:\bpixie|<@)/i.test(body);
  if (referential) return { addressed: true, invocation: false, referential: true };
  const startsWithMention = !!botUserId && stripped.startsWith(`<@${botUserId}>`);
  const startsWithName = new RegExp(`^(?:hey|hi|hello|yo|please|pls)[\\s,]+|^\\b(?:${botNamePattern(botNames)})\\b`, "i").test(stripped);
  if (startsWithMention || startsWithName) return { addressed: true, invocation: true, referential: false };

  const anchorIndex = mentioned ? body.indexOf(`<@${botUserId}>`) : named.index;
  const after = body.slice(anchorIndex, anchorIndex + 60);
  if (/(?:^|[\s,])(?:can|could|would|will|do|does|did|is|are|was|were|how|what|when|where|why|which|who|help|tell|show|give|find|check|explain|do you know|any idea|anyone know)\b/i.test(after)) {
    return { addressed: true, invocation: true, referential: false };
  }
  return { addressed: true, invocation: true, referential: false };
}

const DEFERRAL_RES = [
  /asking\s+\S+\s+specifically/i,
  /wait(?:ing)?\s+for\s+(?:<@|the\s+reviewers|the\s+helpers)/i,
  /\blet\s+(?:<@|[A-Z][a-z]+)\b/i,
  /\bleave\s+(?:this|that|it|this\s+one)\s+to\s+(?:<@|me\b)/i,
  /\bdefer\s+to\s+(?:<@|[A-Z])/i,
  /\bone\s+of\s+the\s+(?:reviewers|helpers|organizers|mods)\b/i,
  /(?:<@[A-Z0-9]+(?:\|[^>]+)?>|[A-Z][a-z]{2,})\s+(?:will|can)\s+answer\b/,
  /\b[a-z]{3,}\s+(?:will|can)\s+answer\s+(?:when|if|once|shortly|soon)\b/,
  /\b[Ss]pecifically\b.*<@/i,
];

// A message aimed at a named human/helper. Leading @-mention or deferral
// verbs near a human mention. Never fires on Pixie invocations.
function humanDirected(text, { botUserId = null } = {}) {
  const body = String(text || "");
  const stripped = body.replace(/^[\s,.;:!?-]+/, "");
  // Bare deferral verbs need no mention syntax to be unambiguous.
  if (/^(?:asking|waiting for|deferring to)\b/i.test(stripped)) return true;
  if (DEFERRAL_RES.some((re) => re.test(body))) return true;
  const others = otherMentions(body, botUserId);
  if (others.length === 0) return false;
  if (stripped.startsWith(others[0])) return true;
  const firstAt = body.indexOf(others[0]);
  const window = body.slice(Math.max(0, firstAt - 40), firstAt + 40);
  if (DEFERRAL_RES.some((re) => re.test(window) || re.test(body))) return true;
  // Bare "Name, question?" without mention syntax cannot resolve names, but a
  // leading deferral verb phrase still counts.
  if (/^(?:asking|waiting for|deferring to)\b/i.test(stripped)) return true;
  return false;
}

const TAKEOVER_RES = [
  /\bi(['’]ll| will) (handle|take|check|look into|look at|deal with|take care of) (this|that|it)\b/i,
  /\blet me (check|look|handle|take|see)\b/i,
  // "wait for Gabin/me" claims handling; "wait for it/the build" is just waiting.
  /\bwait for\s+(?:<@|me\b|him\b|her\b|them\b|[A-Z][a-z]+)/i,
  /\bleave (this|that|it|this one) to me\b/i,
  /\bone of the reviewers is checking\b/i,
  // Human subjects only — "the docs will answer" is not a takeover.
  /(?:<@[A-Z0-9]+(?:\|[^>]+)?>|[A-Z][a-z]{2,}|[Ii])\s+(?:will|can)\s+answer\b/i,
  /\basking \S+ specifically\b/i,
  /\bi(['’]ll| will) take this\b/i,
  /\bi got this\b/i,
];

function takeoverCue(text, botNames = []) {
  const body = String(text || "");
  const names = [...new Set([...(botNames || []), "pixie"])].map(escapeRegex).join("|");
  // "asking Pixie specifically" summons the bot — it does not hand off.
  if (new RegExp(`asking\\s+(?:${names})\\w*\\s+specifically`, "i").test(body)) return false;
  return TAKEOVER_RES.some((re) => re.test(body));
}

const REACTIVATE_RES = [
  /\bcome back\b/i,
  /\bwake up\b/i,
  /\bunmute\b/i,
  /\bresume\b/i,
  /\bcontinue\b/i,
  /\bare you there\b/i,
  /\byou there\b/i,
  /^help\b/i,
  /\bhelp me\b/i,
];

function reactivationPhrase(text) {
  return REACTIVATE_RES.some((re) => re.test(String(text || "")));
}

const GREETING_RES = /^(?:hi+|hello+|hey+|yo|sup|gg+|lol|lmao|haha+|hehe|lets? go+|lfg+|wooo+|yay+|test(?:ing)?|thanks?|thx|ok|who's there)\b/i;

function substantiveQuestion(text) {
  const body = String(text || "").replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, " ").trim();
  if (/\?/.test(body)) return true;
  if (/\b(?:how|what|when|where|why|which|who|whom|whose|can|could|would|should|is|are|was|were|does|do|did|will|has|have|any|help|explain|tell|show|need|want|looking for)\b/i.test(body)) return true;
  return body.split(/\s+/).filter(Boolean).length > 6;
}

function greetingOrNoise(text) {
  const body = String(text || "").replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, " ").replace(/:[a-z0-9_+-]+:/gi, " ").trim();
  if (!body) return true;
  // A real question is never noise, however it opens ("gg! quick q: …?",
  // "hi, how do i submit").
  if (/\?/.test(body) || substantiveQuestion(text)) return false;
  if (GREETING_RES.test(body)) return true;
  // Emoji/punct-only, or a lone token with no question in it ("fire", "42").
  if (!/[a-z0-9]/i.test(body)) return true;
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length === 1 && !substantiveQuestion(text)) return true;
  return false;
}

const ACK_RES = /^(?:thanks?|thx|ty|got it|understood|nvm|never ?mind|solved|fixed it|works now|that worked|ok|okay|k|cool|nice|perfect|awesome|great|makes sense|yes|yeah|yep|no|nope|nah)\W*$/i;

function ackOnly(text) {
  const body = String(text || "").trim();
  if (ACK_RES.test(body)) return true;
  // Self-resolution with a short tail and no question in it.
  const m = body.match(/^(nvm|never ?mind|figured it out|all good|solved|fixed|got it|no worries|ok|okay|thanks?)\b[\s,!.]*/i);
  if (!m) return false;
  const tail = body.slice(m[0].length).trim();
  if (/\?/.test(tail)) return false;
  // "ok thanks" is done; "ok sending logs now" is new information.
  if (/^(thanks|thank you|got it|figured it out|never ?mind|all good|sorted|done|fixed|solved|works)\W*$/i.test(tail)) return true;
  return tail.split(/\s+/).filter(Boolean).length <= 1;
}

// Shared with the answer pipeline (respond.js): categories the organizers
// marked human-only always bypass AI, wherever the check runs. Presence alone
// is not enough — "found money on the street" mentions money without asking
// for anything, so a request signal (?, request verb, leading imperative)
// must accompany the term. Stems stay strict: "eligible" never matches the
// "eligibility" category.
const SENSITIVE_REQUEST_RES = /\?|\b(can|could|would|should|will|please|pls|help|need|want|get|give|approve|override|waive|bypass|extend|charge|verify|review|check|look into|unban|reimburse|refund|process|send|pay|am i|is there|are there|will there|was my|do i)\b/i;
const LEADING_IMPERATIVE_RES = /^(?:<@[^>]+>\s*|(?:hey|hi|hello|yo|please|pls)[\s,]+)?[a-z]{3,12}\s+(?:me|my|the|this|that|a|an|for)\b/i;
const HUMAN_REQUEST_RES = /\b(?:human|person|helper|organizer|someone|somebody)\b/i;
const HUMAN_REQUEST_SHAPE_RES = /\b(?:can|could|would|please|pls|need|want|help|ask|look|review|check|talk|speak|contact|connect|escalat|manually?|make|grant|approve)\w*\b/i;
const ACCOUNT_INTERVENTION_RES = /\b(?:account|login|log[ -]?in|sign[ -]?in|access|password|locked|unlock|credentials)\b/i;
const POLICY_EXCEPTION_RES = /\b(?:manual(?:ly)?\s+(?:override|review|check)|override|exception|waive|waiver|bypass|eligib(?:le|ility)|policy|age)\b/i;

function explicitHumanRequest(text) {
  const body = String(text || "").trim();
  if (!body) return false;
  const explicitHuman = HUMAN_REQUEST_RES.test(body) && HUMAN_REQUEST_SHAPE_RES.test(body);
  return explicitHuman;
}

function humanReviewRequest(text) {
  const body = String(text || "").trim();
  if (!body) return false;
  const hasQuestion = /\?/.test(body);
  const accountIntervention = ACCOUNT_INTERVENTION_RES.test(body) && HUMAN_REQUEST_SHAPE_RES.test(body);
  const policyException = POLICY_EXCEPTION_RES.test(body) && (HUMAN_REQUEST_SHAPE_RES.test(body) || hasQuestion);
  return explicitHumanRequest(body) || accountIntervention || policyException;
}

function sensitiveHit(text, program) {
  const cats = program && Array.isArray(program.sensitiveCategories) ? program.sensitiveCategories : [];
  const body = String(text || "");
  if (humanReviewRequest(body)) return true;
  if (cats.length === 0) return false;
  const lowered = body.toLowerCase();
  const mentioned = cats.some((cat) => {
    const term = String(cat || "").trim().toLowerCase();
    if (term.length < 3) return false;
    // Exact term plus a trailing plural s/es ("clawbacks" counts, "author"
    // never matches the "auth" category).
    return new RegExp(`\\b${escapeRegex(term)}(?:s|es)?\\b`).test(lowered);
  });
  if (!mentioned) return false;
  if (SENSITIVE_REQUEST_RES.test(body) || LEADING_IMPERATIVE_RES.test(body.trim())) return true;
  // A plain question about the category ("is this legal advice binding")
  // still needs a human; only incidental statements pass through.
  return substantiveQuestion(body);
}

function shouldPixieRespond({
  text,
  userId = null,
  botUserId = null,
  botNames = [],
  isHelpChannel = false,
  isTopLevel = true,
  isDM = false,
  posture = "active",
  program = null,
  thread = null,
  actorIsHelper = false,
} = {}) {
  const t = thread || {};
  const body = String(text || "");

  // Muted threads: only reactivation or a directly-addressed substantive
  // question gets a single reply (mute stays on); everything else is silent.
  if (t.muted) {
    const inv = invocationAnalysis(body, { botUserId, botNames });
    const bare = body.replace(/^<@[^>]+>\s*|^\s*(?:hey|hi|hello|yo|please|pls)[\s,]+/i, "").replace(new RegExp(`^(?:${botNamePattern(botNames)})\\w*\\s*`, "i"), "").trim();
    if (inv.invocation && (reactivationPhrase(body) || /^(help|help me|come back|wake up|unmute|resume|continue)\s*[.!]*$/i.test(bare))) {
      return { decision: REPLY, reason: "reactivated", clearMute: true, clearTakeover: true };
    }
    if (inv.invocation && substantiveQuestion(body)) {
      return { decision: REPLY, reason: "muted_direct_address" };
    }
    return { decision: SILENT, reason: "muted" };
  }

  // Human takeover: same stickiness, same escape hatches.
  if (t.takeover) {
    const inv = invocationAnalysis(body, { botUserId, botNames });
    const bare = body.replace(/^<@[^>]+>\s*|^\s*(?:hey|hi|hello|yo|please|pls)[\s,]+/i, "").replace(new RegExp(`^(?:${botNamePattern(botNames)})\\w*\\s*`, "i"), "").trim();
    if (inv.invocation && (reactivationPhrase(body) || /^(help|help me|come back|wake up|unmute|resume|continue)\s*[.!]*$/i.test(bare))) {
      return { decision: REPLY, reason: "takeover_reactivated", clearMute: true, clearTakeover: true };
    }
    if (inv.invocation && substantiveQuestion(body)) {
      return { decision: REPLY, reason: "takeover_direct_address" };
    }
    return { decision: SILENT, reason: "takeover" };
  }

  // A fresh takeover cue claims the thread from this message on.
  if (!isTopLevel && takeoverCue(body, botNames)) {
    return { decision: HUMAN_DEFER, reason: "human_takeover", markTakeover: true };
  }

  // Explicit bot-management commands must reach their handlers.
  if (/^(!(teach|sum|mute|stfu)\b|\/(?:[a-z0-9-]+-)?(?:teach|sum)\b)/i.test(body.trim())) {
    return { decision: REPLY, reason: "command_bypass" };
  }

  const inv = invocationAnalysis(body, { botUserId, botNames });

  if (posture === "muted") return { decision: SILENT, reason: "posture_muted" };

  // A human being asked beats Pixie volunteering — unless Pixie is invoked
  // too. Skipped in DMs (Pixie is the only audience there). The named human
  // owns the judgment call from here, outranking even sensitive escalation.
  if (!isDM && !inv.invocation && humanDirected(body, { botUserId })) {
    return { decision: HUMAN_DEFER, reason: "human_directed" };
  }

  if (!isDM && !inv.invocation && explicitHumanRequest(body)) {
    return { decision: HUMAN_DEFER, reason: "human_review_request" };
  }

  // Sensitive categories skip generation and go straight to humans — even in
  // DMs, where everything else auto-replies.
  if (sensitiveHit(body, program)) {
    return { decision: ESCALATE, reason: "sensitive_escalation", fileTicket: true };
  }

  // DMs always reply: Pixie is the only audience, so there is nobody to
  // defer to. (Sensitive already escalated above.)
  if (isDM) return { decision: REPLY, reason: "dm" };

  // Referential mention without invocation is never a summons — unless it
  // carries a fresh interrogative ("thanks pixie! where do i upload?"),
  // which the normal channel rules below then judge on their own.
  const freshInterrogative = /\?/.test(body)
    || /^\s*(?:how|what|when|where|why|which|who|can|could|would|should|is|are|do|does|did|will)\b/i.test(body)
    || /\b(?:how|what|when|where|why|which)\b/i.test(body);
  if (inv.referential && !freshInterrogative) {
    return { decision: SILENT, reason: "referential_mention" };
  }

  // Social noise without a question is silence, never a ticket. Bot-directed
  // praise ("pixie is goated") is noise too, unless it carries a question.
  const complimentOnly = /\b(?:goated|the goat|love (?:you|u)|best bot)\b/i.test(body)
    && !/\?/.test(body)
    && body.split(/\s+/).filter(Boolean).length <= 6;
  if (isTopLevel && !inv.invocation && greetingOrNoise(body)) {
    return { decision: SILENT, reason: "greeting", noTicket: true };
  }
  if (isTopLevel && complimentOnly) {
    return { decision: SILENT, reason: "greeting", noTicket: true };
  }

  // Already answered + bare acknowledgement: nothing new to do.
  if (!isTopLevel && t.pixieSpoke && !inv.invocation && ackOnly(body)) {
    return { decision: SILENT, reason: "acknowledged" };
  }

  // Already escalated: anything not directed at Pixie stays quiet while the
  // ticket keeps updating silently underneath — including follow-up questions
  // aimed at the room ("anyone looking?"). Only a Pixie invocation or a fresh
  // program question reopens the public channel.
  if (!isTopLevel && t.ticketOpen && !inv.invocation
    && (!substantiveQuestion(body) || /\b(anyone|everyone|somebody|someone|anybody|you guys|y[’']all)\b/i.test(body) || humanDirected(body, { botUserId }))) {
    return { decision: SILENT, reason: "already_escalated", touchTicket: true };
  }

  if (isHelpChannel) {
    if (isTopLevel) return { decision: REPLY, reason: "help_channel_ask" };
    return { decision: REPLY, reason: "help_thread_followup" };
  }

  // General channels: unmistakable support asks may answer; otherwise only
  // direct invocation earns a reply.
  if (inv.invocation) return { decision: REPLY, reason: "addressed" };
  if (!isTopLevel && t.pixieSpoke) return { decision: REPLY, reason: "thread_followup" };
  return { decision: SILENT, reason: "general_channel_quiet" };
}

module.exports = {
  shouldPixieRespond,
  invocationAnalysis,
  humanDirected,
  takeoverCue,
  reactivationPhrase,
  greetingOrNoise,
  substantiveQuestion,
  ackOnly,
  sensitiveHit,
  humanReviewRequest,
  otherMentions,
  directMention,
  REPLY,
  SILENT,
  ESCALATE,
  HUMAN_DEFER,
};
