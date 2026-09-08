// Shared hosted routing: workspace + channel → program.
//
// The explicit program_channels claim table is authoritative for hosted
// programs; the legacy in-config channel lists remain the fallback for
// dedicated/self-host deployments. A channel owned by two programs is a
// configuration error surfaced loudly, never resolved by guessing.
const db = require("./db");
const programs = require("./programs");
const log = require("./log");

function resolveChannelProgram({ workspaceId = null, channelId }) {
  if (!channelId) return programs.shared();
  const ws = workspaceId || "default";

  let claim = null;
  try {
    claim = db.getChannelOwner(ws, channelId);
  } catch (e) {
    log.debug("routing", `failed to get channel owner for ${ws}:${channelId}: ${e.message}`);
    claim = null;
  }
  if (claim && claim.program_id) {
    const prog = programs.get(claim.program_id);
    if (prog) return prog;
    log.warn("routing", `channel ${ws}:${channelId} claims missing program ${claim.program_id}`);
  }

  return programs.forChannel(channelId, workspaceId);
}

// Atomic program activation claim used by the hosted onboarding path.
// Either every channel is claimed by this program or none are: a conflict
// rolls back the partial claims so a retry starts clean.
function claimChannelsForProgram({ workspaceId = null, programId, channels = [], claimedBy = null }) {
  const claimed = [];
  for (const ch of channels) {
    const channelId = typeof ch === "string" ? ch : ch.id;
    const kind = (typeof ch === "object" && ch.kind) || "help";
    if (!channelId) continue;
    const res = db.claimProgramChannel({ workspaceId, channelId, programId, kind, claimedBy });
    if (!res.ok) {
      for (const done of claimed) {
        try { db.releaseProgramChannel({ workspaceId, channelId: done, programId }); } catch (e) {
          log.warn("routing", `failed to release program channel ${done} during rollback: ${e.message}`);
        }
      }
      return { ok: false, conflictChannel: channelId, ownerProgramId: res.ownerProgramId };
    }
    claimed.push(channelId);
  }
  return { ok: true, claimed };
}

module.exports = { resolveChannelProgram, claimChannelsForProgram };
