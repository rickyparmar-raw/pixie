-- Per-helper ping eligibility for onboarding step 5 ("eligible for pings").
-- Additive only: every existing helper stays eligible, exactly matching
-- current routing behavior. Mirrored to Core program_helpers.ping_eligible
-- (helper sync `pingIneligible`, helpers/active `pingEligible`), which is
-- what routing reads.
alter table hosted_program_helpers add column if not exists eligible_for_pings boolean not null default true;
