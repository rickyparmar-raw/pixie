# Pixie Hosted Deployment

One shared Pixie Core serves many programs. One Slack app, one `@Pixie`.

## What runs

- **Pixie Core** (`bun index.js`): Slack Socket Mode, answer engine, tickets,
  background jobs (knowledge refresh, gap judging, weekly report, SLA loop,
  SQLite sweeper). Single replica is fine; several can run behind the same
  Slack app for read scale — runtime truth lives in the database, and
  destructive jobs take single-flight leases (`job_leases`).
- **Pixie Wizard** (Next.js): control plane for programs, tickets, knowledge,
  macros, analytics, incidents, retention. Optional at runtime — Core serves
  Slack from last-synced state while Wizard is down.
- **Postgres/Supabase**: control-plane authority (programs, channels, helpers,
  audit). **SQLite** (`PIXIE_DB_PATH`, on a persistent volume): runtime state,
  caches, source-cache fallback.

## Environment (Core)

Required: `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`,
`connections:write`), `SLACK_HELP_CHANNEL`, `SLACK_FAQ_CHANNELS`,
`OPENCODE_API_KEY` (model pool; add `_2`, `_3`… for rotation).

Model cascade is automatic: HCAI → 9Router → OpenRouter → Zen standby, with
per-key cooldowns. Ticketing works with every provider down.

Hosted extras: `PIXIE_WORKSPACE_ID` (Slack team id for tenant boundaries),
`PIXIE_INTERNAL_TOKEN` (long random; enables `/internal/v1/*` for Wizard —
without it the dashboard cannot sync or act). `PIXIE_SLA_CHECK_MIN` (default
15; 0 disables the stale-ticket loop). `PIXIE_DB_PATH=/data/pixie.db` on the
volume.

## Slack app scopes

`chat:write`, **`chat:write.customize`** (program support identity; without a
re-authorization after adding it, branding falls back to plain Pixie),
`channels:history`, `groups:history`, `channels:join`, `app_mentions:read`,
`reactions:read`, `reactions:write`, `commands`, `im:history`, `im:write`,
`channels:read`, `groups:read`, `files:read`. Socket Mode on, Interactivity
on. Generate the manifest with `bun run manifest` — command names derive from
`PIXIE_BOT_SLUG`, shared commands are `/pixie`, `/pixie-guide`,
`/pixie-sources`, `/pixie-help`, `/pixie-admin`.

Regenerate + re-install the app only when scopes/commands change. Adding a
program never touches the manifest.

## Wizard env

`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (server-side only, never `NEXT_PUBLIC`),
`SESSION_SECRET`, `WIZARD_ENCRYPTION_KEY` (base64 32B, AES-256-GCM envelopes),
`HCA_*` (Hack Club Auth), `PIXIE_CORE_BASE_URL` + `PIXIE_INTERNAL_TOKEN`
(same token as Core), `PIXIE_WORKSPACE_ID`, `BASE_URL`, `CRON_SECRET`.
Run `supabase/migrations/*.sql` in order against a disposable project first;
`002`/`003`/`004` are idempotent.

## Health

- Core: `/api/health` (console session) and `/internal/v1/health` (token) —
  models, channels, missing vars.
- Watch: Slack connectivity, knowledge `lastBuiltAt`, provider fallback rate,
  `job_leases` rows stuck with old `expires_at` (a crashed holder self-heals
  by expiry).
- Backups: SQLite via `VACUUM INTO` (never raw copy under WAL) +
  `integrity_check`; Supabase via project backups; keep `BACKUP_MANIFEST.md`
  style records outside the repo.
