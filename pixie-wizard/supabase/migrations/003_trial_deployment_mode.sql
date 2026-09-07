-- Migration 003: deployment mode on legacy trial rows.
--
-- Lets the lifecycle sweep branch: hosted_shared rows suspend the tenant and
-- must never reach Railway project deletion; dedicated_legacy rows keep the
-- existing pause/delete pipeline. Additive and idempotent.

alter table pixie_trials add column if not exists deployment_mode text not null default 'dedicated_legacy'
  check (deployment_mode in ('hosted_shared', 'dedicated_legacy', 'self_hosted'));

alter table pixie_trials add column if not exists hosted_program_id text references hosted_programs(id) on delete set null;
