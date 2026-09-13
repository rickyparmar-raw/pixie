export type AnswerDispositionKind = "reply" | "silent" | "escalate" | "human_defer";
export type AnswerReason =
  | "direct_mention" | "dm" | "help_channel" | "thread_continuation" | "guide_continuation"
  | "off_topic" | "greeting_or_noise" | "ack_only" | "human_directed" | "takeover" | "muted"
  | "ticket_open" | "sensitive_request" | "unclear" | "classifier_failed" | "program_disabled"
  | "rate_limited" | "unknown";

export interface AnswerDispositionBase {
  kind: AnswerDispositionKind;
  reason: AnswerReason;
  shouldCallModel: boolean;
  shouldCreateTicket: boolean;
  shouldTouchExistingTicket: boolean;
  shouldRecordMetric: boolean;
}

export interface ReplyDisposition extends AnswerDispositionBase {
  kind: "reply";
  shouldCallModel: true;
  replyMode: "docs_only" | "help_only" | "always";
}

export interface SilentDisposition extends AnswerDispositionBase {
  kind: "silent";
  shouldCallModel: false;
  silence: "no_op" | "muted" | "off_topic" | "ack" | "rate_limited";
}

export interface EscalateDisposition extends AnswerDispositionBase {
  kind: "escalate";
  shouldCallModel: boolean;
  escalation: "ticket" | "human_review" | "sensitive_request";
}

export interface HumanDeferDisposition extends AnswerDispositionBase {
  kind: "human_defer";
  shouldCallModel: false;
  deferTo: "human" | "existing_ticket";
}

export type AnswerDisposition = ReplyDisposition | SilentDisposition | EscalateDisposition | HumanDeferDisposition;

export function replyDisposition(reason: AnswerReason, replyMode: ReplyDisposition["replyMode"]): ReplyDisposition {
  return { kind: "reply", reason, shouldCallModel: true, shouldCreateTicket: false, shouldTouchExistingTicket: false, shouldRecordMetric: true, replyMode };
}

export function silentDisposition(reason: AnswerReason, silence: SilentDisposition["silence"]): SilentDisposition {
  return { kind: "silent", reason, shouldCallModel: false, shouldCreateTicket: false, shouldTouchExistingTicket: false, shouldRecordMetric: true, silence };
}

export function escalateDisposition(reason: AnswerReason, escalation: EscalateDisposition["escalation"]): EscalateDisposition {
  return { kind: "escalate", reason, shouldCallModel: false, shouldCreateTicket: true, shouldTouchExistingTicket: true, shouldRecordMetric: true, escalation };
}

export function humanDeferDisposition(reason: AnswerReason, deferTo: HumanDeferDisposition["deferTo"]): HumanDeferDisposition {
  return { kind: "human_defer", reason, shouldCallModel: false, shouldCreateTicket: false, shouldTouchExistingTicket: true, shouldRecordMetric: true, deferTo };
}

export function dispositionRequiresPublicReply(disposition: AnswerDisposition): boolean {
  return disposition.kind === "reply" || disposition.kind === "human_defer";
}

export function dispositionRequiresTicket(disposition: AnswerDisposition): boolean {
  return disposition.shouldCreateTicket;
}
