import type { DomainError, Result } from "./result";

export interface SlackTarget { channelId: string; threadTs: string | null }
export interface MessageContent { text: string | null; blocks: readonly unknown[] | null }
export interface ProgramBranding { supportName: string | null; iconUrl: string | null }
export type SlackEffect =
  | { kind: "post_message"; target: SlackTarget; content: MessageContent; branding: ProgramBranding | null; visibility: "public" | "shadow"; correlationId: string | null }
  | { kind: "update_message"; channelId: string; messageTs: string; content: MessageContent }
  | { kind: "delete_message"; channelId: string; messageTs: string }
  | { kind: "add_reaction"; channelId: string; messageTs: string; reaction: string }
  | { kind: "remove_reaction"; channelId: string; messageTs: string; reaction: string }
  | { kind: "sync_ticket_card"; ticketId: number; channelId: string; messageTs: string; statusText: string; content: MessageContent | null };
export type SlackEffectValidationError = DomainError & { code: "invalid_effect" };

export function validateSlackEffect(effect: unknown): Result<SlackEffect, SlackEffectValidationError> {
  if (!effect || typeof effect !== "object" || typeof (effect as { kind?: unknown }).kind !== "string") return { ok: false, error: { code: "invalid_effect", message: "Slack effect is malformed" } };
  const value = effect as Record<string, unknown>;
  if (value.kind === "post_message") {
    const target = value.target as Record<string, unknown> | undefined;
    const content = value.content as Record<string, unknown> | undefined;
    if (!target?.channelId || (!content?.text && !content?.blocks)) return { ok: false, error: { code: "invalid_effect", message: "Post effect needs a target and content" } };
  }
  return { ok: true, value: effect as SlackEffect };
}

export function effectIsPublic(effect: SlackEffect): boolean { return effect.kind === "post_message" && effect.visibility === "public"; }
export function suppressForShadowMode(effects: readonly SlackEffect[]): readonly SlackEffect[] { return effects.filter((effect) => !effectIsPublic(effect)); }
