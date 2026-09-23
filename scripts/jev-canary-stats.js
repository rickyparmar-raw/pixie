// Operator canary summary: Jev gate activity from local metrics only.
// Prints counts, never message content, user/channel ids, docs, or secrets.
// Usage: bun scripts/jev-canary-stats.js [hours]
//   hours defaults to 24. Reads the bot's SQLite metrics table.
const db = require("../lib/db");

db.open();

function main() {
  const hours = Number(process.argv[2] || 24);
  const sinceMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;

  const counts = new Map(db.metricCounts(sinceMs).map((r) => [r.kind, r.count]));
  const decisions = new Map(db.metricDetails("jev_decision", sinceMs).map((r) => [r.detail, r.count]));
  const errors = new Map(db.metricDetails("jev_error", sinceMs).map((r) => [r.detail, r.count]));
  const cacheHits = counts.get("jev_cache_hit") || 0;
  const downstream = new Map(db.metricDetails("jev_downstream_block", sinceMs).map((r) => [r.detail, r.count]));
  const medianMs = db.medianLatency("jev_decision", sinceMs);

  const byAction = { reply: 0, silence: 0, escalate: 0 };
  for (const [detail, n] of decisions) {
    const action = String(detail || "").split(":")[0];
    if (action in byAction) byAction[action] += n;
  }
  const evaluations = byAction.reply + byAction.silence + byAction.escalate;

  console.log(`jev canary stats (last ${hours}h, from metrics table only):`);
  console.log(`total Jev evaluations : ${evaluations}`);
  console.log(`  reply               : ${byAction.reply}`);
  console.log(`  silence             : ${byAction.silence}`);
  console.log(`  escalate            : ${byAction.escalate}`);
  console.log(`cache hits            : ${cacheHits}`);
  console.log(`rate limits           : ${errors.get("rate_limit") || 0}`);
  console.log(`quota exhausted       : ${errors.get("quota") || 0}`);
  console.log(`timeouts              : ${errors.get("timeout") || 0}`);
  console.log(`auth/unavailable/other: ${(errors.get("auth") || 0) + (errors.get("unavailable") || 0) + [...errors].filter(([k]) => !["rate_limit", "timeout", "auth", "unavailable"].includes(k)).reduce((s, [, n]) => s + n, 0)}`);
  console.log(`downstream blocks     : ${[...downstream.values()].reduce((s, n) => s + n, 0)}`);
  console.log(`median eval latency   : ${medianMs === null ? "n/a" : `${medianMs}ms`}`);
}

main();
try {
  db.close && db.close();
} catch (_) {}
process.exit(0);
