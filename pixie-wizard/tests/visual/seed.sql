-- Deterministic seed for visual-regression snapshots (tests/visual/).
--
-- Produces exactly one program ("visual-program") plus the rows every
-- route in wizard.visual.spec.ts reads from Postgres. All ids, emails,
-- and timestamps are fixed so baseline-vs-rewrite screenshots compare
-- equal; rerunning this file is idempotent (deletes before inserting).
--
-- Owner is `dev-local` to match app/api/auth/dev-login/route.ts, which
-- signs in as hcaId=dev-local / dev@localhost. dev-local is also granted
-- wizard superadmin so the superadmin-gated routes (/overview, /programs)
-- render instead of redirecting.
--
-- Apply AFTER migrations:  DATABASE_URL=... psql -f tests/visual/seed.sql
-- (migrations live in db/migrations/ and run via `npm run migrate`).

begin;

-- Idempotent reruns: delete seeded rows first (children before parents).
delete from wizard_entitlements where program_id = 'visual-program';
delete from hosted_program_helpers where program_id = 'visual-program';
delete from hosted_program_channels where program_id = 'visual-program';
delete from hosted_audit_events where program_id = 'visual-program';
delete from hosted_programs where id = 'visual-program';
delete from wizard_global_access where hca_id in ('dev-local', 'visual-helper-hca');
delete from wizard_people where hca_id in ('dev-local', 'visual-helper-hca');

-- Directory identities. wizard_people is only the identity anchor;
-- program membership stays in hosted_program_helpers.
insert into wizard_people (hca_id, email, display_name, slack_user_id, status, added_by_hca_id, added_at, updated_at) values
  ('dev-local', 'dev@localhost', 'Local Dev', 'U_VISUAL_OWNER', 'active', 'dev-local', '2024-07-01T12:00:00Z', '2024-07-01T12:00:00Z'),
  ('visual-helper-hca', 'helper@example.com', 'Visual Helper', 'U_VISUAL_HELPER', 'active', 'dev-local', '2024-07-01T12:00:00Z', '2024-07-01T12:00:00Z');

-- The one visual fixture program. status=active, owner=dev-local,
-- core_sync_state=synced (no pending banner in snapshots).
insert into hosted_programs (
  id, workspace_id, program_name, program_description, support_name, icon_url,
  reply_signature, owner_hca_id, owner_slack_id, deployment_mode, status,
  ai_answers, tickets_enabled, auto_escalate, posture, scope,
  sensitive_categories, sources, guides, milestones, settings,
  incident_mode, public_tickets_enabled,
  core_sync_state, core_sync_error, core_synced_at,
  created_at, updated_at
) values (
  'visual-program', 'visual-workspace', 'Visual Program',
  'Deterministic fixture program for visual regression snapshots.',
  'Pixie', null,
  null, 'dev-local', 'U_VISUAL_OWNER', 'hosted_shared', 'active',
  true, true, true, 'active', 'program',
  '[]',
  '[{"type": "url", "label": "Visual Docs", "url": "https://example.com/visual-docs", "public": true}, {"type": "json-faq", "label": "Visual FAQ", "url": "https://example.com/visual-faq.json", "public": false}]',
  '["submit-ysws-guidelines"]', '[]', '{}',
  'ANSWER_AND_TRACK', true,
  'synced', null, '2024-07-03T12:00:00Z',
  '2024-07-03T12:00:00Z', '2024-07-03T12:00:00Z'
);

-- Channel claims. The help claim drives the public profile + the stub's
-- #visual-help entry; the organizer claim covers the settings channel UI.
insert into hosted_program_channels (workspace_id, channel_id, program_id, kind, claimed_by_hca_id, created_at) values
  ('visual-workspace', 'C_HELP_VISUAL', 'visual-program', 'help', 'dev-local', '2024-07-03T12:00:00Z'),
  ('visual-workspace', 'C_ORG_VISUAL', 'visual-program', 'organizer', 'dev-local', '2024-07-03T12:00:00Z');

-- Roster: owner (creator provenance) + one visible helper. U_VISUAL_HELPER
-- matches the Core stub's slack/users profiles so identity labels resolve.
insert into hosted_program_helpers (program_id, slack_user_id, helper_source, role, active, visible_on_profile, added_at, removed_at) values
  ('visual-program', 'U_VISUAL_OWNER', 'creator', 'owner', true, true, '2024-07-03T12:00:00Z', null),
  ('visual-program', 'U_VISUAL_HELPER', 'manual', 'helper', true, true, '2024-07-04T12:00:00Z', null);

-- Append-only audit trail (fixed UUIDs, newest last; the page sorts desc).
insert into hosted_audit_events (id, program_id, actor_hca_id, actor_slack_id, action, entity_type, entity_id, metadata, created_at) values
  ('11111111-1111-4111-8111-111111111111', 'visual-program', 'dev-local', 'U_VISUAL_OWNER', 'program.created', 'program', 'visual-program', '{"programId": "visual-program"}', '2024-07-03T12:00:00Z'),
  ('22222222-2222-4222-8222-222222222222', 'visual-program', 'dev-local', 'U_VISUAL_OWNER', 'helper.added', 'helper', 'U_VISUAL_HELPER', '{"slackUserId": "U_VISUAL_HELPER"}', '2024-07-04T12:00:00Z'),
  ('33333333-3333-4333-8333-333333333333', 'visual-program', 'dev-local', 'U_VISUAL_OWNER', 'ticket.resolved', 'ticket', '1001', '{"ticketId": 1001}', '2024-07-05T12:00:00Z');

-- Billing entitlement backing the usage page's quota-health section.
insert into wizard_entitlements (program_id, workspace_id, plan, status, included_cents, effective_from, effective_until, updated_at) values
  ('visual-program', 'visual-workspace', 'starter', 'active', 5000, '2024-07-01T00:00:00Z', null, '2024-07-01T00:00:00Z');

-- Superadmin grant so /overview and /programs render for dev-local
-- instead of redirecting (see requireWizardSuperadmin).
insert into wizard_global_access (hca_id, role, granted_by_hca_id, granted_at) values
  ('dev-local', 'superadmin', 'dev-local', '2024-07-01T12:00:00Z');

commit;
