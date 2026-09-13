import { test, expect } from "bun:test";
import { normalizeLegacySlackEvent } from "../adapters/legacy-slack-event";
import { fromLegacyEligibilityDecision, fromLegacyIntentResult } from "../adapters/legacy-answer";
import { fromLegacyTicketRow } from "../adapters/legacy-ticket";

test("legacy Slack adapter is a compatibility pass-through", () => {
  const result = normalizeLegacySlackEvent({ type: "message", channel: "C1", ts: "100.1", text: "same text", user: "U1" });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.text).toBe("same text");
});

test("legacy answer adapters fail closed on unknown decisions", () => {
  expect(fromLegacyEligibilityDecision({ kind: "reply", mode: "always", reason: "direct_mention" }).ok).toBe(true);
  expect(fromLegacyEligibilityDecision({ kind: "invented" }).ok).toBe(false);
  expect(fromLegacyIntentResult({ shouldAttemptAnswer: false, verdict: "off_topic" }).ok).toBe(true);
});

test("legacy ticket adapter preserves nullable fields and rejects unknown statuses", () => {
  const result = fromLegacyTicketRow({ id: 1, program_id: "p", channel: "C", thread_ts: "T", status: "open", question: "q", workspace_id: null, requester_id: null, assignee_id: null, resolution: null, card_ts: null });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.workspaceId).toBeNull();
  expect(fromLegacyTicketRow({ id: 1, program_id: "p", channel: "C", thread_ts: "T", status: "unknown" }).ok).toBe(false);
});
