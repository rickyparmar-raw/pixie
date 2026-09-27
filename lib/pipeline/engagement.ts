// Conversational engagement: "should Pixie engage with this, and what kind of
// interaction is it?" One service, one result shape. It never sees
// documentation and never decides whether Pixie can answer — retrieval and
// grounding own that.
//
// Classifier: Jev (lib/jevDecision.js). When Jev is switched off
// (JEV_ENABLED unset) the older model classifier in lib/intent.js fills the
// same role so a deployment without Jev still has a working gate. The two
// never run for the same message.
//
// Result: { engage: bool, intent: string|null, error: string|null, source: "jev"|"intent"|"heuristic" }
const jevDecision = require("../jevDecision");
const intent = require("../intent");
const log = require("../log");

// Addressed smalltalk/identity needs no model call.
function isIdentityOrSmalltalk(text: any) {
  const t = String(text || "")
    .replace(/^<@[^>]+>\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, "")
    .trim();
  if (!t) return false;
  if (/\bwho\s*(are|r)\s*(u|you)\b/.test(t)) return true;
  if (/\bwhat\s*(are|r)\s*(u|you)\b/.test(t)) return true;
  if (/\b(your|ur)\s*name\b/.test(t)) return true;
  if (/\babout\s*(yourself|you|u)\b/.test(t)) return true;
  if (/\bwho\s*(made|created|built)\s*(you|u)\b/.test(t)) return true;
  if (/^(hi+|hello+|hey+|yo|sup|thanks?|thx|ty|gm|gn|morning)\b/.test(t) && t.split(/\s+/).length <= 3) return true;
  return false;
}

function postureFor(role: any) {
  if (role === "help") return "help";
  if (role === "dm") return "dm";
  return "main";
}

function fromJev(res: any) {
  if (!res) return { engage: false, intent: null, error: "unknown", source: "jev" };
  if (res.action === "error" || res.errorKind) {
    return { engage: false, intent: null, error: res.errorKind || "unknown", source: "jev" };
  }
  const intentName = res.intent || res.decision?.intent || null;
  return { engage: res.action === "engage", intent: intentName, error: null, source: "jev" };
}

async function fromLegacyIntent({ message, program, userId, channel, addressed, threadMessages, recentMessages }: any) {
  const result = await intent
    .classifyIntentContext(message, program, { userId, channel, addressed, threadMessages, recentMessages })
    .catch(() => null);
  if (!result) return { engage: false, intent: null, error: "unavailable", source: "intent" };
  if (result.directedAtHuman) return { engage: false, intent: "human_conversation", error: null, source: "intent" };
  if (result.verdict === intent.HELP_NEEDED) return { engage: true, intent: "support_question", error: null, source: "intent" };
  if (result.verdict === intent.OFF_TOPIC) return { engage: false, intent: "unrelated_chatter", error: null, source: "intent" };
  return { engage: false, intent: addressed ? "addressed_smalltalk" : "human_conversation", error: null, source: "intent" };
}

// Jev reads context as one plain-text block. Recent channel messages come
// first (oldest to newest), then the thread transcript; the sender's own lines
// are marked so a continuation of their earlier message reads as one.
const RECENT_LINE_CHARS = 200;

function formatRecent(recentMessages: any, userId: any) {
  return (recentMessages || [])
    .filter((m: any) => m && m.text)
    .map((m: any) => {
      const who = m.speaker === "pixie" ? "pixie" : userId && m.userId === userId ? "same sender" : "other member";
      return `${who}: ${String(m.text).replace(/\s+/g, " ").slice(0, RECENT_LINE_CHARS)}`;
    })
    .join("\n");
}

function conversationContextFor({ threadContext, recentMessages, userId }: any) {
  const recent = formatRecent(recentMessages, userId);
  return [recent && `Recent channel messages:\n${recent}`, threadContext && `Thread:\n${threadContext}`]
    .filter(Boolean)
    .join("\n\n");
}

async function classify({ message, threadContext = "", program, role, addressed = false, userId = null, channel = null, threadMessages = [], recentMessages = [] }: any) {
  if (addressed && isIdentityOrSmalltalk(message)) {
    return { engage: true, intent: "addressed_smalltalk", error: null, source: "heuristic" };
  }
  if (jevDecision.isEnabled()) {
    try {
      const res = await jevDecision.evaluateSupportDecision({
        message,
        conversationContext: conversationContextFor({ threadContext, recentMessages, userId }),
        program,
        channelPosture: postureFor(role),
        addressed,
      });
      if (res && res.action !== "existing") return fromJev(res);
    } catch (e: any) {
      log.debug("engagement", `jev threw: ${e.name}`);
      return { engage: false, intent: null, error: "unknown", source: "jev" };
    }
  }
  return fromLegacyIntent({ message, program, userId, channel, addressed, threadMessages, recentMessages });
}

export = { conversationContextFor, classify, isIdentityOrSmalltalk, fromJev };
