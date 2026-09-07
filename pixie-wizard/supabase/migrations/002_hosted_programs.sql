-- Migration 002: hosted shared programs (multi-tenant control plane).
--
-- pixie_trials stays the legacy/dedicated record. Hosted programs live here:
-- configuration for tenants of the already-running shared Pixie Core, not
-- deployments. Every statement is idempotent; re-running is safe.
--
-- Tenant rule mirrored from Core (lib/schema.js): workspace identity is part
-- of every uniqueness boundary. Channel IDs repeat across Slack workspaces.

create table if not exists hosted_programs (
  id text primary key,
  workspace_id text not null default 'default',
  program_name text not null,
  support_name text,
  icon_url text,
  owner_hca_id text not null,
  owner_slack_id text,
  deployment_mode text not null default 'hosted_shared'
    check (deployment_mode = 'hosted_shared'),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'archived')),
  ai_answers boolean not null default true,
  tickets_enabled boolean not null default true,
  auto_escalate boolean not null default true,
  posture text not null default 'active'
    check (posture in ('active', 'passive', 'muted')),
  scope text not null default 'program'
    check (scope in ('any', 'program')),
  sensitive_categories jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  guides jsonb not null default '["submit-ysws-guidelines"]'::jsonb,
  milestones jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  core_sync_state text not null default 'pending'
    check (core_sync_state in ('pending', 'synced', 'failed')),
  core_sync_error text,
  core_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One owner row per workspace+slug is enough to make double-submit Activate
-- collapse instead of duplicating; the partial index keeps archived slugs
-- reusable without letting two live programs share one.
create unique index if not exists hosted_programs_live_slug_unique
  on hosted_programs (workspace_id, id)
  where status = 'active';

create index if not exists hosted_programs_owner_idx
  on hosted_programs (owner_hca_id, status);

-- Explicit channel claims. The unique (workspace, channel) constraint is the
-- atomic anti-hijack guard: claiming an owned channel fails the insert, and
-- the claimant learns the owning program instead of stealing the channel.
create table if not exists hosted_program_channels (
  workspace_id text not null,
  channel_id text not null,
  program_id text not null references hosted_programs(id) on delete cascade,
  kind text not null default 'help'
    check (kind in ('help', 'organizer', 'discussion', 'announcement')),
  claimed_by_hca_id text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, channel_id)
);

create index if not exists hosted_program_channels_program_idx
  on hosted_program_channels (program_id);

-- Helper membership with provenance. Reconciliation removes as well as adds;
-- active=false with removed_at marks a departure without deleting history.
create table if not exists hosted_program_helpers (
  program_id text not null references hosted_programs(id) on delete cascade,
  slack_user_id text not null,
  helper_source text not null default 'manual'
    check (helper_source in ('creator', 'organizer_channel', 'usergroup', 'manual')),
  role text not null default 'helper'
    check (role in ('helper', 'organizer', 'owner')),
  active boolean not null default true,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (program_id, slack_user_id)
);

-- Append-only audit. No update/delete path; retention archives, never rewrites.
create table if not exists hosted_audit_events (
  id uuid primary key default gen_random_uuid(),
  program_id text references hosted_programs(id) on delete set null,
  actor_hca_id text,
  actor_slack_id text,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hosted_audit_events_program_idx
  on hosted_audit_events (program_id, created_at desc);
