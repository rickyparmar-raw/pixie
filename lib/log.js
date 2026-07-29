// Minimal leveled logger. `debug` is the per-message firehose that used to run
// unconditionally — it's what grew pixie.log to 218KB — so it's behind
// PIXIE_DEBUG now. warn/error always print.
const { config } = require("./config");

function format(scope, args) {
  return [`[pixie/${scope}]`, ...args];
}

function debug(scope, ...args) {
  if (config.debug) console.log(...format(scope, args));
}

function info(scope, ...args) {
  console.log(...format(scope, args));
}

function warn(scope, ...args) {
  console.warn(...format(scope, args));
}

function error(scope, ...args) {
  console.error(...format(scope, args));
}

module.exports = { debug, info, warn, error };
