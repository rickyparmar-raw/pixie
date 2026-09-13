import type { AnswerObservations, LookupResult } from "./answer-orchestration.types";

export interface LegacyAnswerObservations {
  sensitive?: boolean;
  intent?: { verdict?: string | null; shouldAttemptAnswer?: boolean; directedAtHuman?: boolean } | null;
  answer?: LookupResult | null;
  lookup?: { kind?: AnswerObservations["lookup"]["kind"]; result?: LookupResult | null; errorCode?: string };
  ticket?: { existing?: boolean; id?: number | null; ensured?: boolean };
  context?: { thread?: string; effectiveQuestion?: string };
  runtime?: Partial<AnswerObservations["runtime"]>;
  helpChannel?: string | null;
}

export function adaptLegacyAnswerObservations(input: LegacyAnswerObservations): AnswerObservations {
  const result = input.lookup?.result === undefined ? input.answer ?? null : input.lookup.result;
  return {
    eligibility: { sensitive: input.sensitive === true },
    intent: input.intent === null ? null : {
      verdict: input.intent?.verdict ?? null,
      shouldAttemptAnswer: input.intent?.shouldAttemptAnswer === true,
      ...(input.intent?.directedAtHuman === undefined ? {} : { directedAtHuman: input.intent.directedAtHuman }),
    },
    lookup: { kind: input.lookup?.kind ?? (result ? "model" : "none"), result, errorCode: input.lookup?.errorCode },
    ticket: { existing: input.ticket?.existing === true, id: input.ticket?.id ?? null, ensured: input.ticket?.ensured === true },
    context: { thread: input.context?.thread ?? "", effectiveQuestion: input.context?.effectiveQuestion ?? "" },
    runtime: { aiAnswersEnabled: input.runtime?.aiAnswersEnabled ?? true, requireGroundedAnswer: input.runtime?.requireGroundedAnswer ?? false, shadowMode: input.runtime?.shadowMode ?? false },
  };
}
