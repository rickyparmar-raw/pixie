"use strict";

const { config } = require("./config");
const programs = require("./programs");

function boolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function projectProgram(program) {
  const value = program || programs.shared();
  return {
    programId: value.id || null,
    programName: value.name || value.id || "Pixie",
    supportName: value.supportName || null,
    supportIconUrl: value.iconUrl || null,
    posture: ["active", "passive", "muted"].includes(value.posture) ? value.posture : "active",
    scope: value.scope === "program" ? "program" : "any",
    deploymentMode: value.deploymentMode || "dedicated_legacy",
    aiAnswers: boolean(value.aiAnswers, true),
    tickets: {
      enabled: boolean(value.ticketsEnabled, true),
      autoEscalate: boolean(value.autoEscalate, true),
      openReaction: value.openReaction || null,
      resolvedReaction: value.resolvedReaction || null,
      requireHelper: boolean(value.requireHelper, false),
      publicEnabled: boolean(value.publicTicketsEnabled, true),
      incidentMode: value.incidentMode || "ANSWER_AND_TRACK",
    },
    shadowMode: boolean(value.shadowMode, false),
    autoAssign: boolean(value.autoAssign, false),
    requireGroundedAnswer: boolean(value.requireGroundedAnswer, false),
    threadRequireMention: boolean(value.threadRequireMention, false),
    helpChannel: value.helpChannel || null,
    organizerChannel: value.organizerChannel || null,
    channels: Array.isArray(value.channels) ? [...value.channels] : [],
    workspaceId: value.workspaceId || null,
  };
}

function forProgram(programOrId) {
  const program = typeof programOrId === "string" ? programs.get(programOrId) : programOrId;
  return projectProgram(program);
}

function forChannel(channelId, workspaceId = null) {
  return projectProgram(programs.forChannel(channelId, workspaceId));
}

function publicConfig(runtime) {
  return {
    program: runtime.program,
    refreshIntervalMin: config.refreshIntervalMin,
    adminUserIds: [...(config.slack.adminUserIds || [])],
    webBaseUrl: config.web?.baseUrl || null,
    slack: {
      botUserId: config.slack.botUserId || null,
      helpChannel: config.slack.helpChannel || null,
      faqChannels: [...(config.slack.faqChannels || [])],
    },
  };
}

module.exports = { forProgram, forChannel, publicConfig, projectProgram };
