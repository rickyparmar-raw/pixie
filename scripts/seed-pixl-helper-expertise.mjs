// Seeds Pixl's declared helper tags. Cold start only — real counts outweigh these.
// Then: bun scripts/backfill-ticket-categories.mjs --program pixl --apply --rebuild-expertise
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("../lib/db");
const programs = require("../lib/programs");
const helperRoute = require("../lib/helperRoute");

// Terms from real phrasing. First match wins.
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

// From Slack history; three or more answers per tag.
const PIXL_HELPER_TAGS = {
  U0A2SJ7B739: ["review", "ops"],
  U091GMQ14KV: ["review", "ops"],
  U0A1VPETCR3: ["review", "support", "ops"],
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

// Rules live in programs.json; a DB row would override the file.
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
