-- Migration 004: deny-by-default Row Level Security.
--
-- All control-plane access runs server-side with the service-role key (which
-- bypasses RLS) plus explicit application authorization (session, ownership,
-- helper membership). No browser code touches Supabase and no anon key is
-- configured. These policies make that posture structural: even if PostgREST
-- were ever exposed, authenticated/anon roles can read and write nothing.
-- Additive, idempotent, zero effect on the service role.

do $$
declare
  t text;
begin
  foreach t in array array[
    'railway_account_pool', 'pixie_trials', 'trial_events',
    'hosted_programs', 'hosted_program_channels', 'hosted_program_helpers',
    'hosted_audit_events'
  ]
  loop
    execute format('alter table if exists %I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'deny_all') then
      -- `to public` covers every non-owner role on both vanilla Postgres and
      -- Supabase (anon + authenticated). The service role bypasses RLS, so
      -- server-side control-plane access is unaffected.
      execute format('create policy deny_all on %I as restrictive for all to public using (false) with check (false)', t);
    end if;
  end loop;
end
$$;
