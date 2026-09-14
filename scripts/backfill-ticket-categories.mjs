// Backfill ticket categories; optionally rebuild expertise.
// Dry run unless --apply.
//
//   bun scripts/backfill-ticket-categories.mjs --program pixl
//   bun scripts/backfill-ticket-categories.mjs --program pixl --apply
//   bun scripts/backfill-ticket-categories.mjs --program pixl --apply --rebuild-expertise
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../lib/db");
const programs = require("../lib/programs");
const ticketCategory = require("../lib/ticketCategory");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : null;
};

const programId = value("program");
const apply = flag("apply");
const rebuild = flag("rebuild-expertise");

if (!programId) {
  console.error("usage: --program <id> [--apply] [--rebuild-expertise]");
  process.exit(1);
}

programs.invalidate();
const program = programs.get(programId);
if (!program) {
  console.error(`unknown program: ${programId}`);
  process.exit(1);
}
if (!program.categories) {
  console.error(`${programId} has no category rules configured — nothing to classify against.`);
  console.error("Set programs.categories first (byChannel / byKeyword / fallback).");
  process.exit(1);
}

console.log(`${programId}: rules cover ${ticketCategory.configuredCategories(program.categories).join(", ") || "nothing"}`);
console.log(apply ? "MODE: apply (writing)" : "MODE: dry run (use --apply to write)");

/* ---------------------------------------------------------- classify ----- */

const unclassified = db.handle()
  .query("SELECT id, channel, question FROM tickets WHERE program_id = ? AND category IS NULL")
  .all(programId);

const counts = new Map();
let classified = 0;
for (const ticket of unclassified) {
  const category = ticketCategory.classify({
    question: ticket.question,
    channel: ticket.channel,
    rules: program.categories,
  });
  if (!category) continue;
  counts.set(category, (counts.get(category) || 0) + 1);
  classified += 1;
  if (apply) db.setTicketTriage(ticket.id, { category });
}

console.log(`\ntickets: ${unclassified.length} unclassified, ${classified} would be set`);
for (const [category, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${category.padEnd(14)} ${n}`);
}
if (classified < unclassified.length) {
  console.log(`  (${unclassified.length - classified} matched no rule and stay NULL — add a fallback to catch them)`);
}

/* -------------------------------------------------- rebuild expertise ----- */

if (!rebuild) {
  console.log("\nSkipping expertise rebuild. Pass --rebuild-expertise to recompute it from this history.");
  process.exit(0);
}
if (!apply) {
  console.log("\nExpertise rebuild needs --apply (it reads the categories this run would write).");
  process.exit(0);
}

// Read back post-backfill.
const byTicket = new Map(
  db.handle().query("SELECT id, category FROM tickets WHERE program_id = ?").all(programId)
    .map((row) => [row.id, row.category || "general"]),
);

const events = db.handle()
  .query("SELECT ticket_id, actor_id, event_type FROM ticket_events WHERE program_id = ? AND event_type IN ('resolved','helper_reply')")
  .all(programId);

// Observed counts win. Nested keys avoid separator collisions.
const observed = new Map();
for (const event of events) {
  if (!event.actor_id) continue;
  const category = byTicket.get(event.ticket_id);
  if (!category) continue;
  const perUser = observed.get(event.actor_id) || new Map();
  const entry = perUser.get(category) || { userId: event.actor_id, tag: category, solved: 0, replies: 0 };
  if (event.event_type === "resolved") entry.solved += 1;
  else entry.replies += 1;
  perUser.set(category, entry);
  observed.set(event.actor_id, perUser);
}
const rows = [...observed.values()].flatMap((perUser) => [...perUser.values()]);

const now = Date.now();
for (const entry of rows) {
  db.handle().query(
    `INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, reply_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(program_id, user_id, tag) DO UPDATE SET
       solved_count = excluded.solved_count,
       reply_count = excluded.reply_count,
       updated_at = excluded.updated_at`,
  ).run(programId, entry.userId, entry.tag, entry.solved, entry.replies, now);
}

console.log(`\nexpertise: rebuilt ${rows.length} helper/category rows from ${events.length} events`);
for (const entry of [...rows].sort((a, b) => b.solved - a.solved).slice(0, 20)) {
  console.log(`  ${entry.userId.padEnd(14)} ${entry.tag.padEnd(14)} ${entry.solved} resolved · ${entry.replies} replied`);
}
