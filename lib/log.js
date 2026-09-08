// Minimal leveled logger. `debug` is the per-message firehose that used to run
// unconditionally — it's what grew pixie.log to 218KB — so it's behind
// PIXIE_DEBUG now. warn/error always print.
const { config } = require("./config");

const subscribers = [];

function subscribe(fn) {
  subscribers.push(fn);
  return () => {
    const idx = subscribers.indexOf(fn);
    if (idx !== -1) subscribers.splice(idx, 1);
  };
}

// A throwing subscriber must never break the caller — logging is observability,
// not control flow.
function notify(kind, scope, args) {
  if (subscribers.length === 0) return;
  for (const fn of subscribers) {
    try {
      fn(kind, scope, args);
    } catch (_) {}
  }
}

function format(scope, args) {
  return [`[pixie/${scope}]`, ...args];
}

function emit(print, kind, scope, args) {
  if (print) print(...format(scope, args));
  notify(kind, scope, args);
}

function debug(scope, ...args) {
  emit(config.debug ? (...a) => console.log(...a) : null, "debug", scope, args);
}

function info(scope, ...args) {
  emit((...a) => console.log(...a), "info", scope, args);
}

function warn(scope, ...args) {
  emit((...a) => console.warn(...a), "warn", scope, args);
}

function error(scope, ...args) {
  emit((...a) => console.error(...a), "error", scope, args);
}

module.exports = { debug, info, warn, error, subscribe };
