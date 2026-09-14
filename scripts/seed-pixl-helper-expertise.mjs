// Seeds Pixl's routing config: the category rules tickets are classified
// against, and each helper's declared expertise tags.
//
// Declared tags are a cold start, not the truth. They earn the flat
// category-match bonus so routing has something to go on before there is
// history; once tickets carry categories, the counts rebuilt from real
// resolutions and replies outweigh them. Run this, then:
//
//   bun scripts/backfill-ticket-categories.mjs --program pixl --apply --rebuild-expertise
//
// auto_assign and helper_ping_enabled are not touched by this script.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../lib/db");
const programs = require("../lib/programs");
const helperRoute = require("../lib/helperRoute");

// Terms are drawn from how Pixl participants actually phrase questions, not
// from what the categories are called. Order matters: the first rule that
// matches wins, so review sits above ops because a "fraud review" question is
// a review question even though it mentions money.
const PIXL_CATEGORIES = {
  byChannel: {},
  byKeyword: [
    {
      category: "review",
      match: ["review", "reviewed", "reviewer", "reviewing", "resubmit", "rejected", "approved", "queue", "fraud"],
    },
    {
      category: "ops",
      match: ["payout", "payouts", "shipping", "shipped", "customs", "grant", "fulfillment", "multiplier", "store", "order", "address"],
    },
    {
      category: "support",
      match: ["journal", "journals", "hackatime", "hours", "repo", "submit", "submission"],
    },
  ],
  fallback: "support",
};

// From a read of Pixl's Slack history. Only helpers with at least three
// substantive answers in a tag are listed; everyone else is deliberately absent
// rather than guessed at, and keeps whatever tags they already had.
const PIXL_HELPER_TAGS = {
  U0A2SJ7B739: ["review", "ops"],
  U091GMQ14KV: ["review", "ops"],
  // All-rounder: answers across all three.
  U0A1VPETCR3: ["review", "support", "ops"],
  // Adds ops on new evidence; keeps the support tag it was seeded with.
  U0A3CUSSP4J: ["ops", "support"],
  U0ARC79GEAV: ["support"],
};

/* ------------------------------------------------------- category rules -- */

programs.invalidate();
const pixl = programs.get("pixl");
if (!pixl) {
  console.error("pixl is not a known program — nothing to seed.");
  process.exit(1);
}

// Pixl is file-configured and has no row in the programs table. Calling
// saveProgram here would create one, and since a DB row wins over the file
// outright, every later edit to programs.json would silently stop applying.
// So the rules live in programs.json (see PIXL_CATEGORIES below for the exact
// block) and this script only verifies they arrived.
if (!pixl.categories) {
  console.error("pixl has no category rules. Add this to its programs.json entry, then redeploy:\n");
  console.error(`  "categories": ${JSON.stringify(PIXL_CATEGORIES, null, 2).split("\n").join("\n  ")}\n`);
  process.exit(1);
}
console.log(`pixl categories: ${require("../lib/ticketCategory").configuredCategories(pixl.categories).join(", ")}`);

/* ---------------------------------------------------------- expertise ---- */

for (const [userId, tags] of Object.entries(PIXL_HELPER_TAGS)) {
  const helper = db.listHelpers("pixl", true).find((row) => row.user_id === userId);
  if (!helper) {
    console.log(`skipped ${userId}: not in Pixl helper history`);
    continue;
  }
  const existing = helperRoute.getExpertise("pixl", userId).map((row) => row.tag).sort();
  const expected = [...tags].sort();
  if (JSON.stringify(existing) === JSON.stringify(expected)) {
    console.log(`already correct ${userId}: ${tags.join(", ")}`);
    continue;
  }
  helperRoute.setExpertise({ programId: "pixl", userId, tags });
  console.log(`seeded ${userId}: ${tags.join(", ")}`);
}

console.log("\nPixl routing seeded; auto_assign and helper pings are unchanged.");
console.log("Next: bun scripts/backfill-ticket-categories.mjs --program pixl --apply --rebuild-expertise");
