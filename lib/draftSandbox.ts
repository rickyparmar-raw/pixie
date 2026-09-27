// Drafts have explicit bindings and never enter production program or channel claims.
const db = require("./db");
import type { SlackClient } from "./types";

const DRAFT_PROGRAMS = new Map();
const DRAFT_BINDINGS = new Map();

interface DraftBinding {
  channelId?: string;
  channel_id?: string;
  role: "help" | "ticket";
  draftProgramId?: string;
  program_id?: string;
  workspaceId?: string;
  workspace_id?: string;
  sandboxOnly: boolean;
  enabled: boolean;
  id?: number;
  card_ts?: string | null;
}

interface DraftProgram {
  id: string;
  name?: string;
  status: string;
  privateSandboxOnly: boolean;
  workspaceId?: string | null;
  sourceTexts?: Record<string, string>;
  sandboxBindings?: Array<{ channelId: string; role: "help" | "ticket" }>;
  autoAssign?: boolean;
  ticketsEnabled?: boolean;
  lifecycle?: string;
}

function ensureTables() {
  db.handle().exec(`CREATE TABLE IF NOT EXISTS draft_sandbox_programs (program_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS draft_sandbox_sources (program_id TEXT NOT NULL, source_name TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (program_id, source_name)); CREATE TABLE IF NOT EXISTS draft_sandbox_bindings (program_id TEXT NOT NULL, workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (program_id, workspace_id, channel_id, role)); CREATE TABLE IF NOT EXISTS draft_sandbox_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, workspace_id TEXT NOT NULL, channel TEXT NOT NULL, thread_ts TEXT NOT NULL, sink_channel TEXT NOT NULL, requester_id TEXT NOT NULL, question TEXT NOT NULL, card_ts TEXT, created_at INTEGER NOT NULL, UNIQUE(program_id, workspace_id, thread_ts));`);
}

function register(program: DraftProgram): DraftProgram | undefined {
  ensureTables();
  if (!program || program.status !== "suspended" || program.privateSandboxOnly !== true) throw new Error("only private suspended drafts may be registered");
  DRAFT_PROGRAMS.set(program.id, { ...program, lifecycle: "draft" });
  db.handle().query("INSERT OR REPLACE INTO draft_sandbox_programs (program_id, payload, created_at) VALUES (?, ?, ?)").run(program.id, JSON.stringify(program), Date.now());
  for (const [name, text] of Object.entries(program.sourceTexts || {})) db.handle().query("INSERT OR REPLACE INTO draft_sandbox_sources (program_id, source_name, text) VALUES (?, ?, ?)").run(program.id, name, text);
  for (const binding of program.sandboxBindings || []) {
    if (!binding.channelId || !["help", "ticket"].includes(binding.role)) throw new Error("invalid draft sandbox binding");
    const owner = db.getChannelOwner(program.workspaceId || "default", binding.channelId);
    if (owner) throw new Error(`sandbox channel ${binding.channelId} is already production-claimed`);
    DRAFT_BINDINGS.set(`${program.workspaceId || "default"}:${binding.channelId}`, { ...binding, draftProgramId: program.id, workspaceId: program.workspaceId || "default", sandboxOnly: true, enabled: true });
    db.handle().query("INSERT OR REPLACE INTO draft_sandbox_bindings (program_id, workspace_id, channel_id, role, enabled) VALUES (?, ?, ?, ?, 1)").run(program.id, program.workspaceId || "default", binding.channelId, binding.role);
  }
  return DRAFT_PROGRAMS.get(program.id);
}

function getForChannel(channelId: string, workspaceId: string | null = null): DraftBinding | null {
  // Production may use the default workspace; an explicit channel binding remains safe to match.
  if (!channelId) return null;
  const exact = DRAFT_BINDINGS.get(`${workspaceId || "default"}:${channelId}`);
  if (exact && exact.enabled) return exact;
  for (const binding of DRAFT_BINDINGS.values()) {
    if (binding.channelId === channelId && binding.enabled) return binding;
  }
  try {
    ensureTables();
    const row = db.handle().query("SELECT * FROM draft_sandbox_bindings WHERE channel_id = ? AND enabled = 1 LIMIT 1").get(channelId) || null;
    if (!row) return null;
    return { channelId: row.channel_id, role: row.role, draftProgramId: row.program_id, sandboxOnly: true, enabled: true, workspaceId: row.workspace_id };
  } catch (_) {
    return null;
  }
}

function get(programId: string): DraftProgram | null {
  return DRAFT_PROGRAMS.get(programId) || null;
}

function list(): DraftProgram[] {
  return [...DRAFT_PROGRAMS.values()];
}

function clear() {
  DRAFT_PROGRAMS.clear();
  DRAFT_BINDINGS.clear();
}

function loadPersisted(): void {
  ensureTables();
  for (const row of db.handle().query("SELECT payload FROM draft_sandbox_programs").all()) {
    try { register(JSON.parse(row.payload)); } catch (_) {}
  }
}

function bindingRows(): DraftBinding[] {
  ensureTables();
  return db.handle().query("SELECT * FROM draft_sandbox_bindings WHERE enabled = 1 ORDER BY program_id, role, channel_id").all();
}

function ticketSinkFor(programId: string, workspaceId: string | null = null): string | null {
  const workspace = workspaceId || "default";
  for (const binding of DRAFT_BINDINGS.values()) {
    if (binding.draftProgramId === programId && binding.role === "ticket" && binding.enabled && (binding.workspaceId || workspace) === workspace) return binding.channelId;
  }
  const row = db.handle().query("SELECT channel_id FROM draft_sandbox_bindings WHERE program_id = ? AND workspace_id = ? AND role = 'ticket' AND enabled = 1 LIMIT 1").get(programId, workspace);
  return row?.channel_id || null;
}

function getTicketForThread(programId: string, workspaceId: string | null = null, threadTs: string): DraftBinding | null {
  ensureTables();
  return db.handle().query("SELECT * FROM draft_sandbox_tickets WHERE program_id = ? AND workspace_id = ? AND thread_ts = ?").get(programId, workspaceId || "default", threadTs) || null;
}

async function ensureSupportTicket({ programId, workspaceId = null, channel, threadTs, requesterId, question, client }: { programId: string; workspaceId?: string | null; channel: string; threadTs: string; requesterId: string; question: string; client?: SlackClient | null }): Promise<DraftBinding | null> {
  if (!programId || !threadTs || !channel || !requesterId || !question) return null;
  ensureTables();
  const workspace = workspaceId || "default";
  const sinkChannel = ticketSinkFor(programId, workspace);
  if (!sinkChannel) return null;
  let ticket = getTicketForThread(programId, workspace, threadTs);
  if (!ticket) {
    db.handle().query("INSERT OR IGNORE INTO draft_sandbox_tickets (program_id, workspace_id, channel, thread_ts, sink_channel, requester_id, question, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(programId, workspace, channel, threadTs, sinkChannel, requesterId, question, Date.now());
    ticket = getTicketForThread(programId, workspace, threadTs);
  }
  if (!ticket || ticket.card_ts || !client) return ticket;
  const program = get(programId);
  const result = await require("./slackMessages").sendProgramMessage({
    client,
    program,
    channel: sinkChannel,
    text: `*[${program?.name || programId} sandbox ticket #${ticket.id}]*\n*Question:* ${require("./reply").escapeSlack(question)}\n*Requester:* <@${requesterId}> in <#${channel}>`,
  });
  if (result?.ts) {
    const claimed = db.handle().query("UPDATE draft_sandbox_tickets SET card_ts = ? WHERE id = ? AND card_ts IS NULL").run(result.ts, ticket.id);
    if (claimed.changes > 0) ticket.card_ts = result.ts;
  }
  return getTicketForThread(programId, workspace, threadTs);
}

export = { register, getForChannel, get, list, clear, loadPersisted, bindingRows, getTicketForThread, ensureSupportTicket };
