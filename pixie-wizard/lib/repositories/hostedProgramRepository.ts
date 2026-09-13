import {
  addHostedHelper,
  getHostedProgram,
  getHelperRow,
  getPublicProgramProfile,
  getWizardPerson,
  hasPersistedWizardSuperadmin,
  isBootstrapSuperadmin,
  isWizardSuperadmin,
  listActiveHostedPrograms,
  listHostedAudit,
  listHostedChannels,
  listHostedHelpers,
  listHostedProgramsForOwner,
  listHostedProgramsPendingSync,
  listProgramAccessForPerson,
  listProgramsForHelperSlackId,
  listVisibleHelperIdentityKeys,
  listWizardPeople,
  logHostedAudit,
  markSyncState,
  revokeHostedHelper,
  revokeWizardSuperadmin,
  setHelperVisibility,
  setHostedHelperRole,
  setWizardSuperadmin,
  updateHostedProgram,
  upsertWizardPerson,
} from "@/lib/hostedPrograms";
import {
  claimHostedChannels,
  findChannelConflicts,
  insertHostedProgram,
  type ChannelClaim,
} from "@/lib/programClaim";
import { query } from "@/lib/db";
import type { HostedProgramRow } from "@/lib/types";

// This boundary deliberately delegates to the current production modules. It
// gives the next migration a typed seam without creating a second data-access
// implementation or changing any SQL, return shape, or authorization rule.
export interface HostedProgramRepository {
  getHostedProgram: typeof getHostedProgram;
  listHostedProgramsForOwner: typeof listHostedProgramsForOwner;
  listActiveHostedPrograms: typeof listActiveHostedPrograms;
  getPublicProgramProfile: typeof getPublicProgramProfile;
  listVisibleHelperIdentityKeys: typeof listVisibleHelperIdentityKeys;
  listHostedProgramsPendingSync: typeof listHostedProgramsPendingSync;
  updateHostedProgram: typeof updateHostedProgram;
  markSyncState: typeof markSyncState;
  listHostedChannels: typeof listHostedChannels;
  logHostedAudit: typeof logHostedAudit;
  listHostedAudit: typeof listHostedAudit;
  addHostedHelper: typeof addHostedHelper;
  listHostedHelpers: typeof listHostedHelpers;
  getHelperRow: typeof getHelperRow;
  setHelperVisibility: typeof setHelperVisibility;
  setHostedHelperRole: typeof setHostedHelperRole;
  revokeHostedHelper: typeof revokeHostedHelper;
  upsertWizardPerson: typeof upsertWizardPerson;
  listWizardPeople: typeof listWizardPeople;
  getWizardPerson: typeof getWizardPerson;
  listProgramAccessForPerson: typeof listProgramAccessForPerson;
  listProgramsForHelperSlackId: typeof listProgramsForHelperSlackId;
  setWizardSuperadmin: typeof setWizardSuperadmin;
  isWizardSuperadmin: typeof isWizardSuperadmin;
  hasPersistedWizardSuperadmin: typeof hasPersistedWizardSuperadmin;
  isBootstrapSuperadmin: typeof isBootstrapSuperadmin;
  revokeWizardSuperadmin: typeof revokeWizardSuperadmin;
  findChannelConflicts: typeof findChannelConflicts;
  insertHostedProgram: typeof insertHostedProgram;
  claimHostedChannels: typeof claimHostedChannels;
}

export type { ChannelClaim };

export const hostedProgramRepository: HostedProgramRepository = {
  async getHostedProgram(id) {
    const { rows } = await query<HostedProgramRow>(`select * from hosted_programs where id = $1`, [id]);
    return rows[0] ?? null;
  },
  listHostedProgramsForOwner,
  listActiveHostedPrograms,
  getPublicProgramProfile,
  listVisibleHelperIdentityKeys,
  listHostedProgramsPendingSync,
  updateHostedProgram,
  markSyncState,
  listHostedChannels,
  logHostedAudit,
  listHostedAudit,
  addHostedHelper,
  listHostedHelpers,
  getHelperRow,
  setHelperVisibility,
  setHostedHelperRole,
  revokeHostedHelper,
  upsertWizardPerson,
  listWizardPeople,
  getWizardPerson,
  listProgramAccessForPerson,
  listProgramsForHelperSlackId,
  setWizardSuperadmin,
  isWizardSuperadmin,
  hasPersistedWizardSuperadmin,
  isBootstrapSuperadmin,
  revokeWizardSuperadmin,
  findChannelConflicts,
  insertHostedProgram,
  claimHostedChannels,
};
