import brand = require("./brand");
import configModule = require("./config");
import guides = require("./guides");
import type { Program } from "./types";

const { isAdmin } = configModule;

// This table is the help surface; entries must stay aligned with registered commands.
interface Capability {
  suffix: string;
  label: string;
  description: string;
  usage?: string;
  helperOnly?: boolean;
  available?: (args: { actorId: string | null; program: Program | null }) => boolean;
}

const CAPABILITIES: readonly Capability[] = Object.freeze([
  { suffix: "", label: "ask", description: "Private answer — help without cluttering the channel", usage: "[question]" },
  { suffix: "", label: "help", description: "Show commands available to you", usage: "help" },
  { suffix: "guide", label: "guide", description: "Interactive step-by-step walkthrough guides", usage: "[guide-name]", available: ({ program }) => !program || guides.availableFor(program).length > 0 },
  { suffix: "check", label: "check", description: "Check GitHub repository readiness for YSWS submission", usage: "<github_repo_url>" },
  { suffix: "calc", label: "calc", description: "Calculate build hours, RE progression, and shop item goals", usage: "<hours/re/item>" },
  { suffix: "sources", label: "sources", description: "What's loaded and when it last refreshed" },
  { suffix: "stats", label: "stats", description: "Answer rate, cache hits, feedback, latency" },
  { suffix: "gaps", label: "gaps", description: "Top questions the docs didn't cover", helperOnly: true },
  { suffix: "report", label: "report", description: "The weekly report now", usage: "[last]", helperOnly: true },
  { suffix: "teach", label: "teach", description: "Teach an answer directly", usage: "<question> :: <answer>", helperOnly: true },
  { suffix: "pending", label: "pending", description: "Captured answers awaiting review", helperOnly: true },
  { suffix: "approve", label: "approve", description: "Start using a captured answer", usage: "<n>", helperOnly: true },
  { suffix: "forget", label: "forget", description: "Drop answer(s) by id, range, pending, or all", usage: "<target>", helperOnly: true },
  { suffix: "reload", label: "reload", description: "Re-fetch the docs and clear the cache, no restart", helperOnly: true },
  { suffix: "program", label: "program", description: "Manage program channels and posture", usage: "[list|add|set|remove]", helperOnly: true },
]);

function availableCapabilities({ actorId = null, program = null }: { actorId?: string | null; program?: Program | null } = {}) {
  return CAPABILITIES.filter((capability) => {
    if (capability.helperOnly && !isAdmin(actorId)) return false;
    return !capability.available || capability.available({ actorId, program });
  });
}

function formatHelp({ actorId = null, program = null }: { actorId?: string | null; program?: Program | null } = {}) {
  const title = program ? `*${program.name} commands*` : `*${brand.name()} commands*`;
  const lines = availableCapabilities({ actorId, program }).map((capability) => {
    const command = brand.cmd(capability.suffix);
    return `• \`${command}${capability.usage ? ` ${capability.usage}` : ""}\` — ${capability.description}`;
  });
  return `${title}\n${lines.join("\n")}`;
}

export = { CAPABILITIES, availableCapabilities, formatHelp };
