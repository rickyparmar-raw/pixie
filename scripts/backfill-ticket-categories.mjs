// Backfill ticket categories, and optionally rebuild helper expertise from the
// history that produces.
//
// Why this exists: nothing set ticket.category until classification landed, so
// every existing ticket is NULL and every accrued expertise row sits under the
// single tag "general". Routing's specialist bonus matches a helper's tag
// against the ticket's category, so until this runs over the backlog, a program
// that has just configured rules still routes as if nobody has a speciality.
//
// Dry-run by default. Nothing is written without --apply.
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

// Read back post-backfill so the rebuild sees the categories just written.
const byTicket = new Map(
  db.handle().query("SELECT id, category FROM tickets WHERE program_id = ?").all(programId)
    .map((row) => [row.id, row.category || "general"]),
);

const events = db.handle()
  .query("SELECT ticket_id, actor_id, event_type FROM ticket_events WHERE program_id = ? AND event_type IN ('resolved','helper_reply')")
  .all(programId);

// Observed history is authoritative for counts. Declared tags a helper has but
// never worked in are left untouched — they keep their 0s and still earn the
// flat category-match bonus.
// Nested rather than a composite string key: a user id and a category joined
// by any separator is a collision waiting for the first category containing it.
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
