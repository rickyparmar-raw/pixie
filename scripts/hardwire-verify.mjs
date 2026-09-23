// Runtime verification of Hardwire onboarding — runs inside the pixie (Core)
// container: `bun scripts/hardwire-verify.mjs`. Read-mostly; the only writes are
// per-source knowledge refreshes (persist to source_cache on the shared volume,
// which is exactly what the 30-min auto-refresh does).
const programs = require("../lib/programs");
const db = require("../lib/db");
const tickets = require("../lib/tickets");
const knowledge = require("../lib/knowledge");

const WS = "T0266FRGM";
const HELP = "C0BK9C320KH";        // #hardwire-support
const ORG = "C0BV468JJMV";         // #hardwire-support-tix
const MAIN = "C0BF8115UJK";        // #hardwire
const BULLETIN = "C0BKNPFMK54";    // #hardwire-bulletin
const SANDBOX_HELP = "C0C04LB6VA5";
const PIXL_HELP = "C0B6STY9G5N";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  cond ? pass++ : fail++;
};

programs.invalidate();

// 1. program exists
const hw = programs.get("hardwire");
check("Core program 'hardwire' exists", !!hw);
check("  support identity = Mr.wire", hw?.supportName === "Mr.wire", hw?.supportName);
check("  posture = active", hw?.posture === "active", hw?.posture);
check("  scope = program", hw?.scope === "program", hw?.scope);
check("  deploymentMode = hosted_shared", hw?.deploymentMode === "hosted_shared", hw?.deploymentMode);
check("  aiAnswers ON", hw?.aiAnswers === true);
check("  ticketsEnabled ON", hw?.ticketsEnabled === true);
check("  publicTicketsEnabled ON", hw?.publicTicketsEnabled === true);
check("  autoEscalate ON", hw?.autoEscalate === true);
check("  autoAssign OFF", hw?.autoAssign === false);
check("  workspace = T0266FRGM", hw?.workspaceId === WS, hw?.workspaceId);

// 2/3. channel routing
const helpProg = programs.forChannel(HELP, WS);
check("forChannel(#hardwire-support, T0266FRGM) -> hardwire", helpProg?.id === "hardwire", helpProg?.id);
check("isHelpChannel(#hardwire-support, T0266FRGM) = true", programs.isHelpChannel(HELP, WS) === true);
const org = tickets.getOrganizerChannel(hw, WS);
check("getOrganizerChannel(hardwire) -> #hardwire-support-tix", org === ORG, org);
const orgClaim = db.getChannelOwner(WS, ORG);
check("  #hardwire-support-tix claim kind = organizer", orgClaim?.kind === "organizer" && orgClaim?.program_id === "hardwire", JSON.stringify(orgClaim));

// 4. main + bulletin NOT claimed / NOT help
check("#hardwire NOT claimed", !db.getChannelOwner(WS, MAIN), JSON.stringify(db.getChannelOwner(WS, MAIN)));
check("#hardwire-bulletin NOT claimed", !db.getChannelOwner(WS, BULLETIN));
check("isHelpChannel(#hardwire) = false", programs.isHelpChannel(MAIN, WS) === false);
check("isHelpChannel(#hardwire-bulletin) = false", programs.isHelpChannel(BULLETIN, WS) === false);
const mainProg = programs.forChannel(MAIN, WS);
check("forChannel(#hardwire) is NOT hardwire (falls to shared/ysws-global)", mainProg?.id !== "hardwire", mainProg?.id);

// 5. helpers
const helpers = db.listHelpers("hardwire");
const hset = new Set(helpers.filter((h) => h.active).map((h) => h.user_id));
for (const [id, who] of [["U0B6FDY0NDB", "Cal"], ["U0ABRTX4BDF", "migrantor"], ["U0A1ABVN50D", "lowpoly"], ["U0B19TZKXFX", "Anna"], ["U0A1VPETCR3", "Ricky"]]) {
  check(`helper ${who} (${id}) active`, hset.has(id));
}
check("  exactly 5 active helpers", [...hset].length === 5, `${[...hset].length}`);
check("  no platform_admin / owner-role sprawl", helpers.every((h) => ["helper", "organizer", "owner"].includes(h.role)));

// 12. Pixl + sandbox untouched
check("sandbox #pixie-sandbox still -> pixie-sandbox-e2e/help", (() => { const c = db.getChannelOwner(WS, SANDBOX_HELP); return c?.program_id === "pixie-sandbox-e2e" && c?.kind === "help"; })());
check("Pixl help channel still -> pixl", programs.forChannel(PIXL_HELP)?.id === "pixl");
check("program list = pixl, pixie-sandbox-e2e, hardwire", JSON.stringify(programs.all().map((p) => p.id).sort()) === JSON.stringify(["hardwire", "pixie-sandbox-e2e", "pixl"]), programs.all().map((p) => p.id).join(","));

// 10. knowledge sources refresh
console.log("\n--- knowledge source refresh (hardwire) ---");
for (const src of hw.sources) {
  try {
    const text = await knowledge.fetchSourceText(src, true);
    const ok = !!(text && text.trim().length > 50);
    if (ok) {
      db.saveSourceText(knowledge.sourceCacheKey(src) || src.name, text);
    }
    check(`source "${src.name}"`, ok, ok ? `${text.length} chars` : "empty/failed");
  } catch (e) {
    check(`source "${src.name}"`, false, e.message);
  }
}

// 11 + 13. tenant isolation of retrieval
console.log("\n--- retrieval / isolation ---");
knowledge.invalidate();
const ctx = knowledge.getContext("does my project repo need to be a public github repo for a hardwire submission?", "hardwire");
check("hardwire context mentions Hardwire docs", /hardwire|iCE40|tapeout|verilog|RTL|tier/i.test(ctx), `${ctx.length} chars`);
check("hardwire context does NOT pull Pixl game links", !/play Pixl|pixl\.hackclub\.com|hackclub\/pixl/i.test(ctx));
const hwSources = knowledge.getContext("what tiers does hardwire have and what are the rewards", "hardwire");
check("hardwire context has tier/reward info", /FPGA|ASIC|carrier board|shuttle/i.test(hwSources));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
