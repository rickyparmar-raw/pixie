export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface DomainError {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
