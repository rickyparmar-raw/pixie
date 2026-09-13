import { normalizeSlackEvent, type NormalizedSlackEvent } from "../domain/slack-event";
import type { Result } from "../domain/result";

export function normalizeLegacySlackEvent(input: unknown): Result<NormalizedSlackEvent, ReturnType<typeof normalizeSlackEvent> extends Result<unknown, infer E> ? E : never> {
  return normalizeSlackEvent(input);
}
