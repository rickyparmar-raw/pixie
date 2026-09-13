export interface EffectSink<T = Record<string, unknown>> { write(effect: T): void }

export function noopEffects<T = Record<string, unknown>>(): EffectSink<T> {
  return { write() {} };
}

export function captureEffects<T>(target: T[]): EffectSink<T> {
  return { write(effect: T) { target.push(effect); } };
}
