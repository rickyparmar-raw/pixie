#!/usr/bin/env node
// Explicit LIVE smoke for the Jev classifier. Hits the real Experiential Labs
// endpoint with the real key, so it is NEVER run by the unit tests or the
// per-file runner — invoke by hand only:
//
//   EXPERIENTIAL_API_KEY=... bun scripts/jev-live-smoke.js ["message here"]
//
// Exits 0 on a well-formed verdict, 1 on any failure.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jev = require("../lib/jevDecision");

const message = process.argv.slice(2).join(" ") || "what is restoration energy?";

async function main() {
  if (!process.env.EXPERIENTIAL_API_KEY) {
    console.error("jev-live-smoke: EXPERIENTIAL_API_KEY is not set; refusing to run.");
    process.exit(1);
  }
  const startedAt = Date.now();
  const res = await jev.evaluateSupportDecision(
    {
      message,
      conversationContext: "",
      program: { id: "pixl", name: "Pixl" },
      channelPosture: "main",
      addressed: false,
    },
  );
  console.log(JSON.stringify({ ...res, wallMs: Date.now() - startedAt }, null, 2));
  const ok = ["engage", "silence", "error", "existing"].includes(res.action) && typeof res.latencyMs === "number";
  if (!ok) {
    console.error("jev-live-smoke: malformed verdict");
    process.exit(1);
  }
  if (res.action === "error") {
    console.error(`jev-live-smoke: provider error (${res.errorKind})`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`jev-live-smoke: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
