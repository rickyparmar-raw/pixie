// Deployment providers: hosted-shared configuration vs dedicated Railway
// provisioning. Normal onboarding never touches the Railway pool; legacy
// trials keep their existing pipeline behind the dedicated provider until
// migration is proven safe. The split is behavioral, not a rename.

import type { DeploymentMode } from "@/lib/types";

export const DEPLOYMENT_MODES: DeploymentMode[] = ["hosted_shared", "dedicated_legacy", "self_hosted"];

export interface HostedActivation {
  mode: "hosted_shared";
  programId: string;
  workspaceId: string;
}

export interface DedicatedProvision {
  mode: "dedicated_legacy";
  trialId: string;
}

// Hosted activation performs no deployment work at all: the program row,
// channel claims, and helper bootstrap are the activation. Core picks the
// tenant up on sync (seconds, no restart, no container).
export async function activateHostedProgram(input: {
  createProgram: () => Promise<HostedActivation>;
}): Promise<HostedActivation> {
  return input.createProgram();
}

export function isHostedMode(mode: string | null | undefined): boolean {
  return mode === "hosted_shared";
}

export function isDedicatedMode(mode: string | null | undefined): boolean {
  return mode === "dedicated_legacy";
}

// The sweeper branches on this: hosted trials must never reach Railway
// project deletion. A hosted expiry suspends the tenant; only dedicated
// legacy rows may pause/delete Railway resources.
export function sweeperScopeFor(mode: string | null | undefined): "hosted" | "dedicated" {
  return isHostedMode(mode) ? "hosted" : "dedicated";
}
