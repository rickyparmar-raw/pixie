export interface ThreadRow {
  thread_ts: string;
  channel: string | null;
  seeded: number;
  pixie_spoke: number;
  helper_pinged: number;
  updated_at: number;
}

export interface TicketRow {
  id: number;
  program_id: string;
  workspace_id: string | null;
  channel: string;
  thread_ts: string;
  card_ts: string | null;
  requester_id: string;
  question: string;
  status: string;
  assignee_id: string | null;
  resolution: string | null;
  created_at: number;
  claimed_at: number | null;
  resolved_at: number | null;
  category: string | null;
  priority: string | null;
  summary: string | null;
  [column: string]: unknown;
}

export interface ProgramRow {
  id: string;
  name: string;
  workspace_id: string | null;
  behavior: string | null;
  status: string | null;
  [column: string]: unknown;
}

export interface ChannelClaimRow {
  workspace_id: string;
  channel_id: string;
  program_id: string;
  kind: string;
  claimed_by: string | null;
  created_at: number;
}

export interface TicketEventRow {
  id: number;
  ticket_id: number;
  program_id: string;
  actor_id: string | null;
  event_type: string;
  detail: string | null;
  created_at: number;
}

export interface AuditEventRow {
  id: number;
  program_id: string | null;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: string | null;
  created_at: number;
}

export interface LearnedFactRow {
  id: number;
  program_id: string;
  question: string;
  answer: string;
  status: string;
  category: string | null;
  created_at: number;
  updated_at: number | null;
  [column: string]: unknown;
}
