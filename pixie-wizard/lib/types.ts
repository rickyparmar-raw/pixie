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
  owner_hca_id: string;
  owner_slack_id: string | null;
  deployment_mode: DeploymentMode;
  status: HostedProgramStatus;
  ai_answers: boolean;
  tickets_enabled: boolean;
  auto_escalate: boolean;
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
  added_at: string;
  removed_at?: string | null;
}
