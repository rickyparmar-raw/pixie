import { escalateDisposition, humanDeferDisposition, replyDisposition, silentDisposition } from "../domain/answer-disposition";
import type { AnswerRequest, AnswerObservations, AnswerRun } from "./answer-orchestration.types";

function grounded(result: AnswerObservations["lookup"]["result"]): boolean {
  if (!result?.source || !result.answer.trim() || result.unclear) return false;
  return result.source.trim().toUpperCase() !== "NONE" && !/^\s*(?:i am|i'm) not sure\b/i.test(result.answer);
}

export function planAnswer(request: AnswerRequest, observations: AnswerObservations): AnswerRun {
  if (observations.eligibility.sensitive) {
    return { handled: true, disposition: escalateDisposition("sensitive_request", "sensitive_request"), effects: [{ kind: "ticket.escalate", threadTs: request.threadTs || request.messageTs || "", requesterId: request.userId, question: request.question }] };
  }

  if (request.mode === "help-only" && (!observations.intent || !observations.intent.shouldAttemptAnswer)) {
    return { handled: false, disposition: silentDisposition(observations.intent?.directedAtHuman ? "human_directed" : "off_topic", "off_topic"), effects: [{ kind: "metric", name: "silent", reason: "gate_stream", durationMs: 0 }] };
  }

  const result = observations.lookup.result;
  if (request.program.requireGroundedAnswer && !grounded(result)) {
    return { handled: false, disposition: silentDisposition("unknown", "no_op"), effects: [{ kind: "metric", name: "silent", reason: "ungrounded", durationMs: 0 }] };
  }

  if (grounded(result)) {
    const effects: AnswerRun["effects"] = [];
    if (request.channel === request.program.helpChannel && request.threadTs) {
      if (!observations.ticket.ensured) effects.push({ kind: "ticket.ensure", threadTs: request.threadTs, requesterId: request.userId, question: request.question });
    }
    effects.push({ kind: "slack.post", channel: request.channel, threadTs: request.threadTs, text: result.answer });
    effects.push({ kind: "context.append", threadTs: request.threadTs || request.messageTs || "", role: "assistant", content: result.answer, userId: null });
    effects.push({ kind: "metric", name: result.source ? "answer_docs" : "answer_chat", reason: null, durationMs: 0 });
    return { handled: true, disposition: replyDisposition(request.addressed ? "direct_mention" : "help_channel", request.mode), effects };
  }

  if (request.mode === "always") {
    return { handled: true, disposition: humanDeferDisposition("unclear", "human"), effects: [{ kind: "slack.post", channel: request.channel, threadTs: request.threadTs, text: result?.answer || "" }, { kind: "metric", name: "fallback", reason: "chat_error_fallback", durationMs: 0 }] };
  }

  const effects: AnswerRun["effects"] = [];
  if (observations.ticket.id !== null) effects.push({ kind: "ticket.waiting", ticketId: observations.ticket.id });
  if (request.question.trim()) effects.push({ kind: "gap", question: request.question, userId: request.userId, channel: request.channel, threadTs: request.threadTs });
  effects.push({ kind: "metric", name: "silent", reason: "gap_escalated", durationMs: 0 });
  return { handled: true, disposition: escalateDisposition("unclear", "ticket"), effects };
}
