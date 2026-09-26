// Pure decision table for what Pixie does with a message once its program and
// channel role are known. No I/O. Ownership (see docs in README of this dir):
//
//   event eligibility      lib/eligibility.js    deterministic filters only
//   conversational intent  lib/pipeline/engagement.js (Jev)
//   answerability          retrieval + grounding guards (lib/lookup.js)
//   human routing          lib/tickets.js
//   final Slack action     THIS module, carried out by lib/respond.js
//
// Two questions are answered here and nowhere else:
//   planEngagement  — after classification: continue to retrieval, or stop?
//   finalAction     — after retrieval/grounding: reply, admit uncertainty,
//                     hand to a human, or stay silent?

const PROGRAM_INTENTS = new Set(["support_question", "direct_program_question", "ambiguous_followup"]);
const GENERAL_INTENTS = new Set(["addressed_general_request", "addressed_smalltalk"]);
// Banter and member-to-member talk that happens to @mention Pixie ("@x would
// you save @pixie or @pixorpheus?") is conversation, not a program question.
const CHAT_INTENTS = new Set([...GENERAL_INTENTS, "human_conversation", "unrelated_chatter"]);

// kind: "program" — a factual/program question: only a grounded answer may be
//                   posted as fact.
//       "general" — an addressed request unrelated to program facts (a recipe,
//                   a joke, "who are you"): the normal conversational model
//                   answers, still through the numeric/policy guards.
function planEngagement({ role, settings, addressed = false, addressedHow = "mention", engagement }) {
  const e = engagement || {};
  if (role === "none") return { proceed: false, reason: "unclaimed_channel" };

  if (role === "dm") {
    return { proceed: true, kind: CHAT_INTENTS.has(e.intent) ? "general" : "program", reason: "dm" };
  }

  if (!settings || settings.enabled === false) return { proceed: false, reason: `${role}_disabled` };

  // Organizer channels resolve with main-channel settings whose ambient and
  // ticket switches are forced off (lib/channelPolicy.js).
  if (role === "main" || role === "organizer") {
    if (addressed) {
      if (settings.mentionReplies === false) return { proceed: false, reason: "mention_replies_off" };
      if (addressedHow === "thread" && (e.intent === "human_conversation" || e.intent === "unrelated_chatter")) {
        return { proceed: false, reason: "thread_chatter" };
      }
      if (CHAT_INTENTS.has(e.intent) && settings.generalMentionChat === false) {
        return { proceed: false, reason: "general_chat_off" };
      }
      // Addressed always gets a response. When the classifier is unavailable
      // we cannot tell a recipe from a policy question, so treat it as a
      // program question: grounded answer or transparent uncertainty.
      if (e.error) return { proceed: true, kind: "program", reason: "addressed_classifier_error" };
      if (CHAT_INTENTS.has(e.intent) && settings.generalMentionChat !== false) {
        return { proceed: true, kind: "general", reason: "addressed_general" };
      }
      return { proceed: true, kind: "program", reason: "addressed_program" };
    }
    if (settings.ambientProgramReplies === false) return { proceed: false, reason: "ambient_off" };
    // Ambient: fail closed on classifier error, silence on chatter.
    if (e.error) return { proceed: false, reason: "classifier_error_silent" };
    if (e.engage && PROGRAM_INTENTS.has(e.intent)) return { proceed: true, kind: "program", reason: "ambient_program_question" };
    if (e.engage && !e.intent) return { proceed: true, kind: "program", noEscalate: true, reason: "ambient_engage" };
    return { proceed: false, reason: "ambient_chatter" };
  }

  // help
  if (addressed) {
    if (addressedHow === "thread" && (e.intent === "human_conversation" || e.intent === "unrelated_chatter")) {
      return { proceed: false, reason: "thread_chatter" };
    }
    if (e.error) return { proceed: true, kind: "program", support: true, reason: "addressed_classifier_error" };
    if (CHAT_INTENTS.has(e.intent)) return { proceed: true, kind: "general", support: false, reason: "addressed_general" };
    return { proceed: true, kind: "program", support: true, reason: "addressed_support" };
  }
  // A classifier outage must not swallow a support request: the ticket path
  // needs no AI.
  if (e.error) return { proceed: true, kind: "program", support: true, reason: "classifier_error_support" };
  if (e.engage) return { proceed: true, kind: "program", support: true, reason: "help_support" };
  return { proceed: false, reason: "help_chatter" };
}

// After retrieval + generation + guards.
//   grounded   — a grounded answer passed every guard
//   hasAnswer  — the model produced some answer text (grounded or not)
//   unclear    — the model itself said it could not tell
// Returns one of:
//   "reply"      post the grounded answer
//   "reply_chat" post the conversational answer (general kind only)
//   "uncertain"  post a transparent "can't verify" message
//   "escalate"   hand to a human (ticket → waiting_for_helper)
//   "silence"
function finalAction({ role, settings, addressed = false, kind = "program", grounded = false, hasAnswer = false, unclear = false, noEscalate = false }) {
  if (grounded) return "reply";
  // A message the classifier engaged on without naming a program intent may
  // be answered when grounded, but never pulls a human in.
  if (noEscalate && !addressed && role !== "help") return "silence";

  if (kind === "general" && hasAnswer && !unclear) return "reply_chat";

  if (role === "dm") return "uncertain";

  if (role === "help") {
    const s = settings || {};
    if (s.escalateUnknown !== false) return addressed ? "escalate_and_uncertain" : "escalate";
    return addressed ? "uncertain" : "silence";
  }

  // main
  const s = settings || {};
  if (addressed) return s.helperEscalationEnabled ? "escalate_and_uncertain" : "uncertain";
  if (s.helperEscalationEnabled) return "escalate";
  return "silence";
}

module.exports = { planEngagement, finalAction, PROGRAM_INTENTS, GENERAL_INTENTS, CHAT_INTENTS };
