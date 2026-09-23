-- Per-helper ping eligibility for onboarding step 5 ("eligible for pings").
-- Additive only: every existing helper stays eligible, exactly matching
-- current routing behavior. Core does not consume this column yet — it is
-- control-plane state the dashboard owns until the helper-sync contract
-- grows a field for it.
alter table hosted_program_helpers add column if not exists eligible_for_pings boolean not null default true;
