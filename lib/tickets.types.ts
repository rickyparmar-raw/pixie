import type { ChannelRole, Program, SlackClient, Ticket } from "./types";

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn" | string;
  text: string;
  emoji?: boolean;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  text?: SlackTextObject;
  elements?: SlackBlockElement[];
  accessory?: SlackBlockElement;
  [key: string]: unknown;
}

export interface SlackBlockElement {
  type: string;
  action_id?: string;
  text?: SlackTextObject;
  value?: string;
  options?: SlackOption[];
  [key: string]: unknown;
}

export interface SlackOption {
  text: SlackTextObject;
  value: string;
  description?: SlackTextObject;
}

export interface TicketCandidate {
  userId: string;
  role?: string;
  score?: number;
  load?: number;
  reasons?: string[];
  [key: string]: unknown;
}

export interface TicketPolicy {
  createOnSupport: boolean;
  recordTicket: boolean;
  escalate: boolean;
  pingHelpers: boolean;
  expertiseRouting: boolean;
}

export interface TicketRoutingOptions {
  category?: string | null;
  requesterId?: string | null;
  exclude?: string[];
  expertiseRouting?: boolean;
}

export interface TicketActionResult {
  ok?: boolean;
  error?: string;
  deduped?: boolean;
  ticket?: Ticket | null;
  ts?: string | null;
  noteId?: number;
  userId?: string | null;
  updated?: Ticket;
  cardText?: string;
  ackText?: string;
  done?: boolean;
  recorded?: boolean;
  [key: string]: unknown;
}

export interface TicketUIProjection {
  card: { text: string; blocks: SlackBlock[] };
  thread: { text: string; blocks: SlackBlock[] };
  reaction: string | null;
}

export interface SlackError {
  code?: string;
  message?: string;
  data?: { error?: string };
}

export interface IncidentCheckOptions {
  prog: Program | null;
  programId: string;
  question: string;
  ticket: Ticket | null;
  client: SlackClient;
  channel: string;
  threadTs: string;
  requesterId: string;
  resolvedWorkspaceId: string | null;
  placeholder: string | null;
  bypassIncidentMatch: boolean;
}

export interface TicketTransitionOptions {
  ticketId: number;
  actorId?: string | null;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}

export interface ResolveTicketOptions extends TicketTransitionOptions {
  resolution?: string | null;
  source?: string | null;
  resolutionMeta?: Record<string, unknown> | null;
  resolvedAt?: number | null;
  creditId?: string | null;
}

export interface FinishResolveOptions {
  ticket: Ticket;
  actorId: string | null;
  resolution: string | null;
  source?: string | null;
  resolutionMeta?: Record<string, unknown> | null;
  client?: SlackClient | null;
  resolvedAt?: number | null;
  creditId?: string | null;
}

export interface EnsureSupportTicketOptions {
  program: Program | null;
  channel: string;
  threadTs: string;
  requesterId: string;
  question: string;
  client?: SlackClient | null;
  workspaceId?: string | null;
  paging?: boolean;
  role?: ChannelRole | "organizer" | string | null;
  silent?: boolean;
  backfill?: boolean;
  createdAt?: number | null;
  source?: string | null;
}

export interface ParsedTicketAction {
  ticketId: number;
  actorId: string | null;
  workspaceId: string | null;
  assigneeId: string | null;
  triggerId: string | null;
}

export interface TicketActionInput {
  selected_option?: { value?: string };
  value?: string;
}

export interface TicketActionBody {
  user?: { id?: string };
  team?: { id?: string };
  team_id?: string;
  trigger_id?: string;
  channel?: { id?: string };
}

export interface TicketActionView {
  private_metadata?: string;
  state: {
    values: Record<string, Record<string, { value?: string }>>;
  };
}

export interface TicketActionPayload {
  action: TicketActionInput;
  body: TicketActionBody;
  ack: (response?: Record<string, unknown>) => Promise<void>;
  client: SlackClient;
  view: TicketActionView;
}

export interface TicketActionApp {
  action(name: string, handler: (payload: TicketActionPayload) => Promise<void>): void;
  view(name: string, handler: (payload: TicketActionPayload) => Promise<void>): void;
}

export interface TicketDatabaseRow {
  id?: number;
  program_id?: string;
  workspace_id?: string | null;
  channel?: string;
  channel_id?: string;
  kind?: string;
  thread_ts?: string;
  status?: string;
  [key: string]: unknown;
}
