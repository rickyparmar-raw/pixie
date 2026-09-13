import { test, expect } from "bun:test";
import { normalizeSlackEvent, eventThreadTs, isDirectMessage } from "./slack-event";
import { replyDisposition, silentDisposition, escalateDisposition, dispositionRequiresTicket } from "./answer-disposition";
import { canTransition, transitionTicket } from "./ticket";
import { effectIsPublic, suppressForShadowMode, validateSlackEffect } from "./slack-effect";

test("normalizes top-level, threaded, DM, image, and reaction events without inventing content", () => {
  const top = normalizeSlackEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "100.5", text: "hello" });
  expect(top.ok).toBe(true);
  if (!top.ok) return;
  expect(eventThreadTs(top.value)).toBe("100.5");
  expect(top.value.text).toBe("hello");

  const dm = normalizeSlackEvent({ type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "101.1", thread_ts: "100.5", files: [{ mimetype: "image/png", url_private: "https://x", id: "F1" }] });
  expect(dm.ok).toBe(true);
  if (!dm.ok) return;
  expect(isDirectMessage(dm.value)).toBe(true);
  expect(eventThreadTs(dm.value)).toBe("100.5");
  expect(dm.value.attachments[0]?.kind).toBe("image");

  const reaction = normalizeSlackEvent({ type: "reaction_added", item: { channel: "C1", ts: "100.5" }, reaction: "thumbsup", user: "U2" });
  expect(reaction.ok).toBe(true);
  if (reaction.ok) expect(reaction.value.reaction?.name).toBe("thumbsup");
});

test("rejects malformed Slack events at the adapter boundary", () => {
  expect(normalizeSlackEvent(null).ok).toBe(false);
  expect(normalizeSlackEvent({ type: "message" }).ok).toBe(false);
  expect(normalizeSlackEvent({ type: "message", channel: "C1", ts: "bad" }).ok).toBe(false);
});

test("answer dispositions preserve public action semantics", () => {
  expect(replyDisposition("direct_mention", "always").shouldCallModel).toBe(true);
  expect(silentDisposition("off_topic", "off_topic").shouldCallModel).toBe(false);
  expect(dispositionRequiresTicket(escalateDisposition("sensitive_request", "sensitive_request"))).toBe(true);
});

test("ticket transitions preserve claim, resolve, reopen, and invalid context rules", () => {
  expect(canTransition("open", "claim")).toBe(true);
  expect(canTransition("resolved", "claim")).toBe(false);
  const ticket = { ticketId: 1, programId: "p", workspaceId: "w", channelId: "c", threadTs: "t", status: "open" as const, requesterId: "u", assigneeId: null, question: "q", resolution: null, cardTs: null };
  expect(transitionTicket(ticket, "claim", { actorId: "helper", source: "slack" }).to).toBe("claimed");
  expect(transitionTicket(ticket, "snooze", { actorId: "helper", source: "slack" }).reason).toBe("invalid_context");
});

test("Slack effects validate content and shadow mode removes public posts", () => {
  const effect = { kind: "post_message" as const, target: { channelId: "C1", threadTs: null }, content: { text: "hello", blocks: null }, branding: null, visibility: "public" as const, correlationId: null };
  expect(validateSlackEffect(effect).ok).toBe(true);
  expect(effectIsPublic(effect)).toBe(true);
  expect(suppressForShadowMode([effect])).toHaveLength(0);
  expect(validateSlackEffect({ kind: "post_message" }).ok).toBe(false);
});
