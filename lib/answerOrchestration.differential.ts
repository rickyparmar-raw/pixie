import { normalizeEffectTrace, type EffectTraceEntry } from "./answerOrchestration.trace";

export interface TraceMismatch {
  equal: false;
  index: number;
  expected: EffectTraceEntry | undefined;
  actual: EffectTraceEntry | undefined;
}

export type TraceComparison = { equal: true } | TraceMismatch;

export function compareAnswerTraces(expected: readonly EffectTraceEntry[], actual: readonly EffectTraceEntry[]): TraceComparison {
  const left = normalizeEffectTrace(expected);
  const right = normalizeEffectTrace(actual);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return { equal: false, index, expected: left[index], actual: right[index] };
  }
  return { equal: true };
}
