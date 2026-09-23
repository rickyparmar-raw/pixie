-- Per-program behavior toggles + runtime lifecycle for dashboard onboarding.
--
-- `status` already exists on hosted_programs but means the admin lifecycle
-- (active/suspended/archived) — a different axis from whether Pixie is
-- answering yet. `runtime_status` is the Core-facing sandbox|live|paused
-- state: every program created through the wizard starts as 'sandbox' and
-- flips to 'live' only via the deliberate launch action, which syncs the
-- same value to Core's programs.status. Additive only: existing rows keep
-- their lifecycle status and gain empty behavior (Core falls back to its
-- documented defaults) plus sandbox runtime.
alter table hosted_programs add column if not exists behavior jsonb not null default '{}'::jsonb;

alter table hosted_programs add column if not exists runtime_status text not null default 'sandbox'
  check (runtime_status in ('sandbox', 'live', 'paused'));

-- Backfill, not a default change: every row predating this migration is
-- already serving live (there was no sandbox concept before it), so they
-- stay live. Only rows created after this migration start as sandbox.
-- New installs have no rows at migrate time, so this updates zero rows
-- there and the column default governs.
update hosted_programs set runtime_status = 'live'
  where runtime_status = 'sandbox';
