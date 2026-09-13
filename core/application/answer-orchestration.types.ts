import type { AnswerDisposition } from "../domain/answer-disposition";
import type { ProgramRuntimeConfig } from "../domain/runtime-config";

export interface AnswerRequest {
  channel: string;
  threadTs: string | null;
  messageTs: string | null;
  userId: string | null;
  question: string;
  mode: "docs-only" | "help-only" | "always";
  addressed: boolean;
  isDm: boolean;
  workspaceId: string | null;
  program: ProgramRuntimeConfig;
  startedAtMs: number;
}

export interface LookupResult {
  source: string | null;
  answer: string;
  unclear?: boolean;
  direct?: boolean;
}

export interface AnswerObservations {
  eligibility: { sensitive: boolean };
  intent: { verdict: string | null; shouldAttemptAnswer: boolean; directedAtHuman?: boolean } | null;
  lookup: { kind: "cache" | "model" | "failure" | "none"; result: LookupResult | null; errorCode?: string };
  ticket: { existing: boolean; id: number | null; ensured: boolean };
  context: { thread: string; effectiveQuestion: string };
  runtime: { aiAnswersEnabled: boolean; requireGroundedAnswer: boolean; shadowMode: boolean };
}

export interface EffectBase { kind: string }
export type AnswerEffect =
  | { kind: "slack.post"; channel: string; threadTs: string | null; text: string; blocks?: readonly unknown[] }
  | { kind: "slack.update"; channel: string; ts: string; text: string }
  | { kind: "slack.delete"; channel: string; ts: string }
  | { kind: "ticket.ensure"; threadTs: string; requesterId: string | null; question: string }
  | { kind: "ticket.waiting"; ticketId: number }
  | { kind: "ticket.escalate"; threadTs: string; requesterId: string | null; question: string }
  | { kind: "context.append"; threadTs: string; role: "user" | "assistant"; content: string; userId: string | null }
  | { kind: "metric"; name: string; reason: string | null; durationMs?: number }
  | { kind: "gap"; question: string; userId: string | null; channel: string; threadTs: string | null };

export interface AnswerRun {
  handled: boolean;
  disposition: AnswerDisposition;
  effects: readonly AnswerEffect[];
}
