// Row shapes for supabase/schema.sql. *_encrypted fields are ciphertext from
// lib/crypto.ts — decrypt before use, never pass through to a client.

export type TrialStatus =
  | "draft"
  | "awaiting_slack_credentials"
  | "provisioning"
  | "active"
  | "paused"
  | "deleted"
  | "failed";

export interface DocSource {
  type: "url" | "json-faq" | "gdoc";
  url: string;
  label?: string;
}

export interface ChannelRef {
  id: string;
  name: string;
}

export interface ChannelSelection {
  helpChannel?: ChannelRef;
  faqChannels?: ChannelRef[];
}

export interface PixieTrialRow {
  id: string;

  requester_hca_id: string;
  requester_email: string;
  requester_name: string;
  requester_slack_id: string | null;

  program_name: string;
  program_description: string | null;
  bot_name: string | null;

  status: TrialStatus;

  railway_account_pool_id: string | null;
  railway_project_id: string | null;
  railway_service_id: string | null;
  railway_environment_id: string | null;

  slack_workspace_id: string | null;
  slack_workspace_name: string | null;
  slack_bot_user_id: string | null;

  channels: ChannelSelection;

  sources: DocSource[];
  config_snapshot: Record<string, string> | null;

  llm_base_url: string | null;
  llm_model: string | null;
  llm_key_encrypted: string | null;
  slack_bot_token_encrypted: string | null;
  slack_app_token_encrypted: string | null;

  created_at: string;
  expires_at: string | null;

  last_deploy_at: string | null;
  last_deploy_status: string | null;

  expiry_notified_at: string | null;
  paused_at: string | null;
  reclaim_deadline: string | null;
  deleted_at: string | null;
}

export interface RailwayAccountPoolRow {
  id: string;
  label: string;
  api_token_encrypted: string;
  max_concurrent_trials: number;
  current_trial_count: number;
  cooling_until: string | null;
  disabled: boolean;
  created_at: string;
}

export interface TrialEventRow {
  id: string;
  trial_id: string;
  event_type: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}
