import {
  isSuperadminSession,
  linkedSlackSession,
  loadProgramContext,
  ownProgramPath,
  relationshipFor,
  requireProgramMembership,
  requireWizardSuperadmin,
  type ProgramContext,
  type ProgramMembership,
} from "@/lib/programAccess";
import type { HostedProgramRow, ProgramRelationship } from "@/lib/types";
import type { WizardSession } from "@/lib/session";

// Access remains owned by lib/programAccess.ts for now. In particular, this
// service must not reimplement redirects or membership checks: callers can
// migrate to this seam while retaining the exact Next redirect behaviour.
export interface ProgramAccessService {
  relationshipFor(program: HostedProgramRow, session: WizardSession | null): Promise<ProgramRelationship>;
  loadProgramContext(programId: string): Promise<ProgramContext>;
  linkedSlackSession(): Promise<(WizardSession & { slackId: string }) | null>;
  requireProgramMembership(programId: string): Promise<ProgramMembership>;
  isSuperadminSession(identity: { hcaId: string; email: string }): Promise<boolean>;
  ownProgramPath(identity: { hcaId: string; email: string; slackId?: string | null }): Promise<string>;
  requireWizardSuperadmin(): Promise<WizardSession>;
}

export const programAccessService: ProgramAccessService = {
  relationshipFor,
  loadProgramContext,
  linkedSlackSession,
  requireProgramMembership,
  isSuperadminSession,
  ownProgramPath,
  requireWizardSuperadmin,
};
