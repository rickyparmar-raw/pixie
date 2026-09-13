export type EffectTraceEntry = Record<string, unknown> & { kind: string };

export function normalizeEffectTrace(effects: readonly EffectTraceEntry[]): EffectTraceEntry[] {
  return effects.map((effect) => Object.fromEntries(Object.entries(effect).filter(([, value]) => value !== undefined)) as EffectTraceEntry);
}
