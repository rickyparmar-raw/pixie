import { fail, ok, type DomainError, type Result } from "../domain/result";
import { escalateDisposition, humanDeferDisposition, replyDisposition, silentDisposition, type AnswerDisposition, type AnswerReason } from "../domain/answer-disposition";

export type LegacyAnswerShapeError = DomainError & { code: "invalid_legacy_answer" };

function reason(value: unknown): AnswerReason {
  const allowed: AnswerReason[] = ["direct_mention", "dm", "help_channel", "thread_continuation", "guide_continuation", "off_topic", "greeting_or_noise", "ack_only", "human_directed", "takeover", "muted", "ticket_open", "sensitive_request", "unclear", "classifier_failed", "program_disabled", "rate_limited", "unknown"];
  return typeof value === "string" && allowed.includes(value as AnswerReason) ? value as AnswerReason : "unknown";
}

export function fromLegacyEligibilityDecision(value: unknown): Result<AnswerDisposition, LegacyAnswerShapeError> {
  if (!value || typeof value !== "object") return fail({ code: "invalid_legacy_answer", message: "Legacy decision must be an object" });
  const decision = value as Record<string, unknown>;
  const legacyKind = decision.kind || decision.action || decision.verdict;
  const why = reason(decision.reason);
  if (legacyKind === "reply") return ok(replyDisposition(why, decision.mode === "docs_only" || decision.mode === "always" ? decision.mode : "help_only"));
  if (legacyKind === "escalate") return ok(escalateDisposition(why, decision.sensitive ? "sensitive_request" : "ticket"));
  if (legacyKind === "human_defer") return ok(humanDeferDisposition(why, "human"));
  if (legacyKind === "silent" || legacyKind === "off_topic" || legacyKind === "casual_chat") return ok(silentDisposition(why, why === "rate_limited" ? "rate_limited" : "off_topic"));
  return fail({ code: "invalid_legacy_answer", message: "Legacy decision kind is unsupported" });
}

export function fromLegacyIntentResult(value: unknown): Result<AnswerDisposition, LegacyAnswerShapeError> {
  if (!value || typeof value !== "object") return fail({ code: "invalid_legacy_answer", message: "Legacy intent result must be an object" });
  const result = value as Record<string, unknown>;
  if (result.shouldAttemptAnswer === true) return ok(replyDisposition(reason(result.verdict), "help_only"));
  return ok(silentDisposition(reason(result.verdict), result.verdict === "rate_limited" ? "rate_limited" : "off_topic"));
}
