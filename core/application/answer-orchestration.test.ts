import { test, expect } from "bun:test";
import { planAnswer } from "./answer-orchestration.policy";
import type { AnswerObservations, AnswerRequest } from "./answer-orchestration.types";

const program = {
  programId: "p",
  programName: "Program",
  supportName: null,
  supportIconUrl: null,
  posture: "active" as const,
  scope: "any" as const,
  deploymentMode: "dedicated_legacy",
  aiAnswers: true,
  tickets: { enabled: true, autoEscalate: true, openReaction: null, resolvedReaction: null, requireHelper: false, publicEnabled: true, incidentMode: "ANSWER_AND_TRACK" },
  shadowMode: false,
  autoAssign: false,
  requireGroundedAnswer: false,
  threadRequireMention: false,
  helpChannel: "C-HELP",
  organizerChannel: "C-ORG",
  channels: ["C-HELP"],
  workspaceId: "W",
};

function request(overrides: Partial<AnswerRequest> = {}): AnswerRequest {
  return { channel: "C-HELP", threadTs: "T", messageTs: "M", userId: "U", question: "question", mode: "help-only", addressed: false, isDm: false, workspaceId: "W", program, startedAtMs: Date.now(), ...overrides };
}

function observations(overrides: Partial<AnswerObservations> = {}): AnswerObservations {
  return { eligibility: { sensitive: false }, intent: { verdict: "help_needed", shouldAttemptAnswer: true }, lookup: { kind: "model", result: { source: "Docs", answer: "grounded" } }, ticket: { existing: true, id: 1, ensured: true }, context: { thread: "", effectiveQuestion: "question" }, runtime: { aiAnswersEnabled: true, requireGroundedAnswer: false, shadowMode: false }, ...overrides };
}

test("planner escalates sensitive requests without a model result", () => {
  const run = planAnswer(request(), observations({ eligibility: { sensitive: true }, lookup: { kind: "none", result: null } }));
  expect(run.disposition.kind).toBe("escalate");
  expect(run.effects[0]?.kind).toBe("ticket.escalate");
});

test("planner rejects HELP_ONLY intent before lookup effects", () => {
  const run = planAnswer(request(), observations({ intent: { verdict: "casual_chat", shouldAttemptAnswer: false }, lookup: { kind: "none", result: null } }));
  expect(run.handled).toBe(false);
  expect(run.disposition.kind).toBe("silent");
  expect(run.effects.some((effect) => effect.kind === "slack.post")).toBe(false);
});

test("planner preserves ticket-before-answer ordering for grounded help answers", () => {
  const run = planAnswer(request(), observations({ ticket: { existing: false, id: null, ensured: false } }));
  expect(run.effects.map((effect) => effect.kind)).toEqual(["ticket.ensure", "slack.post", "context.append", "metric"]);
});

test("planner fails closed when grounding is required", () => {
  const run = planAnswer(request({ mode: "always", program: { ...program, requireGroundedAnswer: true } }), observations({ lookup: { kind: "model", result: { source: null, answer: "I am not sure" } } }));
  expect(run.handled).toBe(false);
  expect(run.disposition.kind).toBe("silent");
});
