"use strict";

const audit = require("../audit");
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
      freshMs: db.CACHE_FRESH_MS,
      now: () => db.now(),
      read: (hash) => db.handle().query("SELECT source, answer, ask_count, COALESCE(refreshed_at, created_at) AS written_at FROM answer_cache WHERE question_hash = ?").get(hash) || null,
      touch: (hash, askedAt) => db.handle().query("UPDATE answer_cache SET ask_count = ask_count + 1, last_asked_at = ? WHERE question_hash = ?").run(askedAt, hash),
      write: (hash, question, result, writtenAt, refreshed) => db.handle().query(`INSERT INTO answer_cache (question_hash, question, source, answer, created_at, last_asked_at, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(question_hash) DO UPDATE SET source = excluded.source, answer = excluded.answer, refreshed_at = excluded.refreshed_at`).run(hash, question, result.source || null, result.answer, writtenAt, refreshed ? null : writtenAt, writtenAt),
      stale: (cutoff, limit) => db.handle().query(`SELECT question_hash, question, ask_count FROM answer_cache WHERE COALESCE(refreshed_at, created_at) < ? ORDER BY ask_count DESC, COALESCE(refreshed_at, created_at) ASC LIMIT ?`).all(cutoff, limit),
      count: () => db.handle().query("SELECT COUNT(*) AS n FROM answer_cache").get()?.n || 0,
      top: (limit) => db.handle().query("SELECT question_hash, question, ask_count, source, COALESCE(refreshed_at, created_at) AS written_at FROM answer_cache ORDER BY ask_count DESC, question LIMIT ?").all(limit),
      clear: () => db.handle().query("DELETE FROM answer_cache").run().changes,
      forget: (hash) => db.handle().query("DELETE FROM answer_cache WHERE question_hash = ?").run(hash),
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
    tickets: {
      now: () => db.now(),
      addNote: (input) => db.addTicketNote(input),
      listNotes: (ticketId, limit) => db.listTicketNotes(ticketId, limit),
      addEvent: (input) => db.addTicketEvent(input),
      listEvents: (ticketId, limit) => db.listTicketEvents(ticketId, limit),
    },
    helpers: {
      list: (programId, activeOnly) => db.listHelpers(programId, activeOnly),
      isHelper: (programId, userId) => db.isHelper(programId, userId),
    },
    audit: {
      record: (entry) => audit.record(entry),
      list: (options) => db.listAuditEvents(options),
    },
  };
}

module.exports = { createLegacyPersistence };
