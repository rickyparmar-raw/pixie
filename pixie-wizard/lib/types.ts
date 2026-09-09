// Row shapes for supabase/schema.sql.

// Shared shape for useActionState-driven server actions across the app.
export interface ActionState {
  error: string | null;
}

// A knowledge source for the bot's corpus.
//
// `url` and `content` are alternatives, not both: anything fetched has a url,
// while a FAQ typed into the wizard travels inline as `content` and has no url at
// all (the engine's lib/knowledge.js handles both). `name` is what the engine
// keys its cache and citations on — `label` was the old field name and is kept
// readable for rows written before the rename.
export interface DocSource {
  type: "url" | "json-faq" | "gdoc" | "github-dir" | "text" | "pixl-shop";
  name?: string;
  label?: string;
  url?: string;
  siteUrl?: string;
  content?: unknown;
  // Explicit opt-in only — a source with no `public` field (every existing
  // one, since the onboarding form doesn't set it yet) is private by
  // default. The public program profile only ever counts/lists sources
  // where this is exactly `true`.
  public?: boolean;
}

export interface Milestone {
  name: string;
  date: string;
  note?: string;
  questions?: string[];
}

// Deployment modes. Hosted programs are configuration on the shared Core —
// no Railway project, no per-program Slack app, no tokens. Dedicated rows
// keep the legacy isolated-container path until migration is proven safe.
export type DeploymentMode = "hosted_shared" | "dedicated_legacy" | "self_hosted";

export type HostedProgramStatus = "active" | "suspended" | "archived";

export interface HostedProgramRow {
  id: string;
  workspace_id: string;
  program_name: string;
  program_description?: string | null;
  support_name: string | null;
  icon_url: string | null;
  // A fixed line the program appends to its genuine AI/FAQ answers only
  // (Hardwire: "stay wired :hardwire:"). Never on escalations, incidents,
  // errors or status changes. NULL = no signature, default behaviour.
  reply_signature: string | null;
  owner_hca_id: string;
  owner_slack_id: string | null;
  deployment_mode: DeploymentMode;
  status: HostedProgramStatus;
  ai_answers: boolean;
  tickets_enabled: boolean;
  auto_escalate: boolean;
  incident_mode: "ANSWER_ONLY" | "ANSWER_AND_TRACK" | "NORMAL_TICKET";
  public_tickets_enabled: boolean;
  posture: "active" | "passive" | "muted";
  scope: "any" | "program";
  sensitive_categories: string[];
  sources: DocSource[];
  guides: string[];
  milestones: Milestone[];
  settings: Record<string, unknown>;
  core_sync_state: "pending" | "synced" | "failed";
  core_sync_error: string | null;
  core_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HostedProgramChannel {
  workspace_id: string;
  channel_id: string;
  channel_name?: string | null;
  program_id: string;
  kind: "help" | "organizer" | "discussion" | "announcement";
  claimed_by_hca_id: string | null;
  created_at: string;
}

export interface HostedProgramHelper {
  program_id: string;
  slack_user_id: string;
  helper_source: "creator" | "organizer_channel" | "usergroup" | "manual";
  role: "helper" | "organizer" | "owner";
  active: boolean;
  visible_on_profile: boolean;
  added_at: string;
  removed_at?: string | null;
}

export interface WizardPerson {
  hca_id: string;
  email: string;
  display_name: string;
  slack_user_id: string | null;
  status: "active" | "invited" | "disabled";
  added_by_hca_id: string | null;
  added_at: string;
  updated_at: string;
}

// A caller's relationship to a program — drives both the directory's badge
// and every management route's authorization check. "public" is the only
// non-member value; everyone else is some flavor of member.
export type ProgramRelationship = "owner" | "admin" | "helper" | "public";

// Safe projection for anyone who is NOT a member of the program. Every field
// here is deliberately public-appropriate — see lib/programAccess.ts's
// getPublicProgramProfile(), which is the only place allowed to construct
// one of these. Never add a field here without checking it against the
// "never expose" list that request called out (tickets, requester info,
// notes, private channels, learned facts, macros, audit, retention,
// analytics, settings, raw internal IDs).
export interface PublicProgramProfile {
  id: string;
  programName: string;
  description: string | null;
  supportName: string | null;
  iconUrl: string | null;
  status: HostedProgramStatus;
  // The DB projection only ever returns the raw channel id — resolving it to
  // a human "#channel-name" needs a live Core Slack lookup, which is a
  // presentation concern the page does separately (best-effort; falls back
  // to the id itself if Core is unreachable). Keeping that out of this
  // function keeps the DB projection pure and independently testable.
  publicHelpChannelId: string | null;
  publicSourceCount: number;
  roster: Array<{ role: "owner" | "organizer" | "helper" }>;
}

// Identity-resolved roster entry for public display — built by the page
// (never a data-access function) from listVisibleHelperIdentityKeys() +
// Core's coreUserInfo(), specifically so nothing carrying a slack_user_id
// ever exists in the same object as a resolved displayName. `displayName`/
// `avatarUrl` are null when resolution failed or Slack has nothing to
// offer — the UI falls back to a role-only row, it never blocks on this.
export interface PublicHelperIdentity {
  displayName: string | null;
  avatarUrl: string | null;
  role: "owner" | "organizer" | "helper";
}
