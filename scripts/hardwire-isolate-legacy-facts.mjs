// Tenant-isolation data correction, required by the Hardwire onboarding.
//
// lib/db.js approvedFacts(limit, programId) serves rows matching
// `program_id = ? OR program_id IS NULL`, so every learned_facts row with a
// NULL program_id (all taught in Pixl's pre-multi-tenant era, in Pixl channels,
// about Pixl) leaks into every other program's corpus — including Hardwire.
//
// Fix: stamp the legacy NULL rows with 'pixl'. Pixl's own query is
// `program_id = 'pixl' OR program_id IS NULL`, so Pixl keeps every one of them
// and its behaviour is unchanged; Hardwire and pixie-sandbox-e2e stop seeing
// them. No schema change. Idempotent (re-run touches 0 rows).
//
//   bun scripts/hardwire-isolate-legacy-facts.mjs           # report only
//   bun scripts/hardwire-isolate-legacy-facts.mjs --apply
const db = require("../lib/db");
const h = db.handle();
const APPLY = process.argv.includes("--apply");

const before = h.query("SELECT COUNT(*) n FROM learned_facts WHERE program_id IS NULL").get().n;
const sampleNonPixl = h.query(
  `SELECT id, channel, question FROM learned_facts
   WHERE program_id IS NULL
     AND channel IS NOT NULL
     AND channel NOT IN ('C0B6STY9G5N','C0B5P4N0WHH','C0BK4F6STFZ')`,
).all();

console.log(`learned_facts with NULL program_id: ${before}`);
console.log(`  ...of those, taught in a NON-Pixl channel: ${sampleNonPixl.length}`);
for (const r of sampleNonPixl) console.log(`   #${r.id} [${r.channel}] ${r.question.slice(0, 80)}`);

const pixlBefore = db.approvedFacts(9999, "pixl").length;
const hwBefore = db.approvedFacts(9999, "hardwire").length;
const sbBefore = db.approvedFacts(9999, "pixie-sandbox-e2e").length;
console.log(`\napprovedFacts count  pixl=${pixlBefore}  hardwire=${hwBefore}  sandbox=${sbBefore}`);

if (!APPLY) { console.log("\n(dry-run — pass --apply)"); process.exit(0); }

const res = h.query("UPDATE learned_facts SET program_id = 'pixl' WHERE program_id IS NULL").run();
console.log(`\nUPDATE: ${res.changes} rows -> program_id='pixl'`);

const after = h.query("SELECT COUNT(*) n FROM learned_facts WHERE program_id IS NULL").get().n;
const pixlAfter = db.approvedFacts(9999, "pixl").length;
const hwAfter = db.approvedFacts(9999, "hardwire").length;
const sbAfter = db.approvedFacts(9999, "pixie-sandbox-e2e").length;
console.log(`NULL program_id now: ${after}`);
console.log(`approvedFacts count  pixl=${pixlAfter} (was ${pixlBefore})  hardwire=${hwAfter} (was ${hwBefore})  sandbox=${sbAfter} (was ${sbBefore})`);
console.log(pixlAfter === pixlBefore ? "OK: Pixl fact set unchanged" : "WARN: Pixl fact count changed!");
console.log(hwAfter < hwBefore ? "OK: Hardwire no longer sees legacy Pixl facts" : "WARN: Hardwire fact count did not drop");
