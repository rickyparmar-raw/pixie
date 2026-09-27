// Minimal leveled logger. `debug` is the per-message firehose that used to run
// unconditionally — it's what grew pixie.log to 218KB — so it's behind
// PIXIE_DEBUG now. warn/error always print.
import configModule = require("./config");

const { config } = configModule;

const subscribers: Array<(kind: string, scope: string, args: unknown[]) => void> = [];

function subscribe(fn: any) {
  subscribers.push(fn);
  return () => {
    const idx = subscribers.indexOf(fn);
    if (idx !== -1) subscribers.splice(idx, 1);
  };
}

// A throwing subscriber must never break the caller — logging is observability,
// not control flow.
function notify(kind: any, scope: any, args: any) {
  if (subscribers.length === 0) return;
  for (const fn of subscribers) {
    try {
      fn(kind, scope, args);
    } catch (_: any) {}
  }
}

function format(scope: string, args: unknown[]): unknown[] {
  return [`[pixie/${scope}]`, ...args];
}

function emit(print: ((...args: unknown[]) => void) | null, kind: string, scope: string, args: unknown[]): void {
  if (print) print(...format(scope, args));
  notify(kind, scope, args);
}

function debug(scope: string, ...args: unknown[]): void {
  emit(config.debug ? (...a: unknown[]) => console.log(...a) : null, "debug", scope, args);
}

function info(scope: string, ...args: unknown[]): void {
  emit((...a: unknown[]) => console.log(...a), "info", scope, args);
}

function warn(scope: string, ...args: unknown[]): void {
  emit((...a: unknown[]) => console.warn(...a), "warn", scope, args);
}

function error(scope: string, ...args: unknown[]): void {
  emit((...a: unknown[]) => console.error(...a), "error", scope, args);
}

export = { debug, info, warn, error, subscribe };
