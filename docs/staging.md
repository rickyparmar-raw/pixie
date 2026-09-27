# #pixie-sandbox Staging Runbook

Staging lets the finished Unified Pixie build serve **only `#pixie-sandbox`
(`C0C04LB6VA5`)** without touching `#pixl` / `#pixl-help` or legacy bots.

## Safety mechanism

`PIXIE_STAGING_ONLY_CHANNELS` — when set, Core drops every Slack event
outside those channels before any handling (proven by
`staging allowlist drops non-sandbox channels` test). Production traffic is
structurally unreachable even when staging shares workspace credentials.

## 1. Channels (manual, Slack)

- `#pixie-sandbox` exists (`C0C04LB6VA5`).
- Create **`#pixie-sandbox-organizers`** (activation requires a second,
  organizer channel; do not reuse a production channel).
- `/invite @Pixie` into both channels (required before Activate).

## 2. Staging Core (Railway, manual)

New Railway project + service from this branch (`feat/unified-pixie-platform`),
attaching a fresh volume. Environment — copy `deploy/staging/env.staging.example`
and fill ONLY staging values:

- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` — shared @Pixie app tokens (manual)
- `PIXIE_STAGING_ONLY_CHANNELS=C0C04LB6VA5,<organizers-channel-id>`
- `SLACK_HELP_CHANNEL=C0C04LB6VA5`, `SLACK_FAQ_CHANNELS=C0C04LB6VA5`
- `PIXIE_WORKSPACE_ID=T0266FRGM` (Hack Club workspace, confirmed)
- `HCAI_API_KEY` / `OPENCODE_API_KEY` — central model key (manual)
- `PIXIE_INTERNAL_TOKEN` — fresh random (manual, `openssl rand -base64 32`)
- `PIXIE_DB_PATH=/data/pixie-staging.db` (fresh file on the staging volume)
- `PIXIE_ADMIN_USER_IDS` — your Slack user id
- Do NOT set production `PIXIE_DB_PATH`; do NOT reuse production database.

Start the service; confirm Socket Mode connects and `/api/health` is clean.
If the Slack app predates `chat:write.customize`, re-authorize it
(Slack app → OAuth & Permissions → reinstall); branding falls back to plain
Pixie until then.

## 3. Staging database (manual if no staging project exists)

Apply in order against a staging/disposable Supabase project:
`supabase/schema.sql`, `001_fleet_config.sql`, `002_hosted_programs.sql`,
`003_trial_deployment_mode.sql`, `004_rls_deny_by_default.sql`.
All are idempotent; verified 22/22 on disposable Postgres. Never run these
against production for staging purposes.

## 4. Staging Wizard (Vercel or local, manual)

Deploy this branch with staging env: `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
(staging project), `PIXIE_CORE_BASE_URL` + `PIXIE_INTERNAL_TOKEN` (same token
as Core), `PIXIE_WORKSPACE_ID=T0266FRGM`, session/encryption/auth vars.

## 5. Activate the sandbox program

Wizard → Connect with hosted Pixie → name `Pixie Sandbox`, support identity
`Sandbox Help`, help channel `#pixie-sandbox`, organizer channel
`#pixie-sandbox-organizers`, AI + tickets on → Activate. Routing claims ONLY
the sandbox channels (atomic; `#pixl*` never touched).

## 6. Smoke test

Offline (no Slack needed, run any time):
`PIXIE_DB_PATH=/tmp/smoke.db bun scripts/smoke-sandbox.js` — 26 checks.

Live (after deploy): hello/test → silence; sandbox-end question → grounded
branded answer; mention → reply; `ask @Pixie next time` → silence;
human-directed → silence; unsupported → ticket; `stfu pixie` → mute;
muted follow-up → silence; `@Pixie come back` → resume; then
ticket → claim → note → dashboard reply → resolve → reopen → timeline,
plus one copilot draft (must not auto-send). Watch staging logs for
duplicates, routing mistakes, 429s, fallback storms, secret leakage.

## 7. Teardown / rollback

Stop/delete ONLY the staging Railway project and staging Supabase project.
Production is untouched by construction; nothing here can affect it while
`PIXIE_STAGING_ONLY_CHANNELS` is set and staging uses its own database.
