import db = require("./db");
import programs = require("./programs");
import log = require("./log");

interface ChannelSpec {
  id: string;
  kind?: string;
}
interface ResolveOptions {
  workspaceId?: string | null;
  channelId?: string | null;
}
interface ClaimOptions {
  workspaceId?: string | null;
  programId: string;
  channels?: Array<string | ChannelSpec>;
  claimedBy?: string | null;
}

function resolveChannelProgram({ workspaceId = null, channelId }: ResolveOptions) {
  if (!channelId) return programs.shared();
  const ws = workspaceId || "default";

  let claim = null;
  try {
    claim = db.getChannelOwner(ws, channelId);
  } catch (e: unknown) {
    log.debug(
      "routing",
      `failed to get channel owner for ${ws}:${channelId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    claim = null;
  }
  if (claim && claim.program_id) {
    const prog = programs.get(claim.program_id);
    if (prog) return prog;
    log.warn("routing", `channel ${ws}:${channelId} claims missing program ${claim.program_id}`);
  }

  return programs.forChannel(channelId, workspaceId);
}

function claimChannelsForProgram({ workspaceId = null, programId, channels = [], claimedBy = null }: ClaimOptions) {
  // Rollback on conflict
  const claimed = [];
  for (const ch of channels) {
    const channelId = typeof ch === "string" ? ch : ch.id;
    const kind = (typeof ch === "object" && ch.kind) || "help";
    if (!channelId) continue;
    const res = db.claimProgramChannel({ workspaceId, channelId, programId, kind, claimedBy });
    if (!res.ok) {
      for (const done of claimed) {
        try {
          db.releaseProgramChannel({ workspaceId, channelId: done, programId });
        } catch (e: unknown) {
          log.warn(
            "routing",
            `failed to release program channel ${done} during rollback: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return { ok: false, conflictChannel: channelId, ownerProgramId: res.ownerProgramId };
    }
    claimed.push(channelId);
  }
  return { ok: true, claimed };
}

export = { resolveChannelProgram, claimChannelsForProgram };
