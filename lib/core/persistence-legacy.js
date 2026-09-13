"use strict";

const db = require("../db");

function createLegacyPersistence() {
  return {
    lifecycle: {
      open: (filename) => db.open(filename),
      close: () => db.close(),
      ensureSchema: (filename) => db.ensureSchema(filename),
      sweep: () => db.sweep(),
      startSweeper: () => db.startSweeper(),
    },
    raw: {
      handle: () => db.handle(),
    },
    dedupe: {
      claimMessage: (ts, channel = null) => db.claimMessage(ts, channel),
      wasAnswered: (ts) => db.wasAnswered(ts),
    },
    cache: {
      count: () => db.handle().query("SELECT COUNT(*) AS n FROM answer_cache").get()?.n || 0,
      clear: () => db.handle().query("DELETE FROM answer_cache").run().changes,
    },
    programs: {
      list: () => db.getDbPrograms(),
      save: (program) => db.saveProgram(program),
      remove: (id) => db.deleteProgram(id),
      claimChannel: (input) => db.claimProgramChannel(input),
      releaseChannel: (input) => db.releaseProgramChannel(input),
      owner: (workspaceId, channelId) => db.getChannelOwner(workspaceId, channelId),
      listChannels: (programId) => db.listProgramChannels(programId),
    },
    telemetry: {
      recordMetric: (...args) => db.recordMetric(...args),
      recordLlmUsage: (entry) => db.recordLlmUsage(entry),
      usageReport: (options) => db.llmUsageReport(options),
    },
  };
}

module.exports = { createLegacyPersistence };
