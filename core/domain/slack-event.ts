import { fail, ok, type DomainError, type Result } from "./result";

export type SlackEventKind = "message" | "app_mention" | "reaction_added" | "reaction_removed";
export type SlackConversationKind = "channel" | "group" | "im" | "mpim" | "unknown";

export interface SlackEventId {
  eventId: string | null;
  messageTs: string | null;
  threadTs: string | null;
}

export interface SlackConversation {
  id: string;
  kind: SlackConversationKind;
  isThread: boolean;
}

export interface SlackActor {
  userId: string | null;
  isBot: boolean;
}

export interface SlackAttachment {
  kind: "image" | "file" | "unknown";
  mimeType: string | null;
  privateUrl: string | null;
  fileId: string | null;
}

export interface SlackReaction {
  name: string;
  itemUserId: string | null;
  addedByUserId: string | null;
}

export interface NormalizedSlackEvent {
  kind: SlackEventKind;
  ids: SlackEventId;
  conversation: SlackConversation;
  actor: SlackActor;
  text: string;
  timestampMs: number | null;
  attachments: readonly SlackAttachment[];
  reaction: SlackReaction | null;
  rawSubtype: string | null;
}

export type SlackEventNormalizationError = DomainError & {
  code: "invalid_event" | "missing_event_kind" | "missing_channel" | "invalid_timestamp";
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function conversationKind(value: unknown): SlackConversationKind {
  if (value === "im" || value === "mpim" || value === "channel" || value === "group") return value;
  return "unknown";
}

function eventKind(value: unknown): SlackEventKind | null {
  return value === "message" || value === "app_mention" || value === "reaction_added" || value === "reaction_removed"
    ? value
    : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const seconds = Number(value.split(".")[0]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function attachment(value: unknown): SlackAttachment {
  const file = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mimeType = stringOrNull(file.mimetype);
  return {
    kind: mimeType?.startsWith("image/") ? "image" : mimeType ? "file" : "unknown",
    mimeType,
    privateUrl: stringOrNull(file.url_private),
    fileId: stringOrNull(file.id),
  };
}

export function normalizeSlackEvent(input: unknown): Result<NormalizedSlackEvent, SlackEventNormalizationError> {
  if (!input || typeof input !== "object") return fail({ code: "invalid_event", message: "Slack event must be an object" });
  const event = input as Record<string, unknown>;
  const kind = eventKind(event.type);
  if (!kind) return fail({ code: "missing_event_kind", message: "Slack event type is unsupported" });
  const channel = stringOrNull(event.channel) || stringOrNull((event.item as Record<string, unknown> | undefined)?.channel);
  if (!channel) return fail({ code: "missing_channel", message: "Slack event has no channel" });
  const messageTs = stringOrNull(event.ts) || stringOrNull((event.item as Record<string, unknown> | undefined)?.ts);
  const threadTs = stringOrNull(event.thread_ts);
  const timestamp = timestampMs(messageTs);
  if (messageTs && timestamp === null) return fail({ code: "invalid_timestamp", message: "Slack timestamp is invalid" });
  const files = Array.isArray(event.files) ? event.files : [];
  const reactionEvent = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : null;
  return ok({
    kind,
    ids: { eventId: stringOrNull(event.event_id), messageTs, threadTs },
    conversation: { id: channel, kind: conversationKind(event.channel_type), isThread: Boolean(threadTs) },
    actor: { userId: stringOrNull(event.user), isBot: Boolean(event.bot_id) || Boolean(event.subtype === "bot_message") },
    text: typeof event.text === "string" ? event.text : "",
    timestampMs: timestamp,
    attachments: files.map(attachment),
    reaction: kind === "reaction_added" || kind === "reaction_removed"
      ? { name: stringOrNull(event.reaction) || "", itemUserId: stringOrNull(reactionEvent?.user), addedByUserId: stringOrNull(event.user) }
      : null,
    rawSubtype: stringOrNull(event.subtype),
  });
}

export function eventThreadTs(event: NormalizedSlackEvent): string | null {
  return event.ids.threadTs || event.ids.messageTs;
}

export function isDirectMessage(event: NormalizedSlackEvent): boolean {
  return event.conversation.kind === "im";
}

export function isTopLevelMessage(event: NormalizedSlackEvent): boolean {
  return !event.ids.threadTs;
}
