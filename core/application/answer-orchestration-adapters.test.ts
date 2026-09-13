import { test, expect } from "bun:test";
import { adaptLegacyAnswerObservations } from "./legacy-answer-observations";
import { planAnswer } from "./answer-orchestration.policy";
import { captureEffects, noopEffects } from "../../lib/answerOrchestration.effects";
import { normalizeEffectTrace } from "../../lib/answerOrchestration.trace";
import { compareAnswerTraces } from "../../lib/answerOrchestration.differential";
import type { AnswerRequest } from "./answer-orchestration.types";

const request = { channel: "C", threadTs: "T", messageTs: "M", userId: "U", question: "how?", mode: "always", addressed: false, isDm: false, workspaceId: "W", program: { requireGroundedAnswer: false, helpChannel: "C" } as any, startedAtMs: 1 } as AnswerRequest;
const legacy = { sensitive: false, intent: { shouldAttemptAnswer: true }, answer: { source: "Docs", answer: "yes" }, ticket: { existing: false, id: null }, helpChannel: "C" };

test("adapts legacy-like observations without changing their source", () => {
  expect(adaptLegacyAnswerObservations(legacy)).toEqual(expect.objectContaining({
    eligibility: { sensitive: false }, lookup: { kind: "model", result: { source: "Docs", answer: "yes" } },
  }));
});

test("normalizes equivalent effects and reports the first mismatch", () => {
  const effects = [{ kind: "slack.post", channel: "C", threadTs: "T", text: "yes" }];
  expect(normalizeEffectTrace(effects)).toEqual([{ kind: "slack.post", channel: "C", threadTs: "T", text: "yes" }]);
  expect(compareAnswerTraces(effects, [...effects, { kind: "metric", name: "answer_docs", reason: null }])).toEqual({ equal: false, index: 1, expected: undefined, actual: { kind: "metric", name: "answer_docs", reason: null } });
});

test("effect sinks capture and no-op without executing effects", () => {
  const calls: string[] = [];
  const capture = captureEffects(calls);
  capture.write({ kind: "metric", name: "x", reason: null });
  noopEffects().write({ kind: "metric", name: "y", reason: null });
  expect(calls).toEqual([{ kind: "metric", name: "x", reason: null }]);
});

test("differential planning is pure and does not invoke supplied legacy effect runner", () => {
  let invoked = false;
  const run = planAnswer(request, adaptLegacyAnswerObservations(legacy));
  const result = compareAnswerTraces([{ kind: "slack.post", channel: "C", threadTs: "T", text: "yes" }], run.effects);
  expect(invoked).toBe(false);
  expect(result.equal).toBe(false);
});
