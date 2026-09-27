# Staging runbook

Use a separate Slack channel, database, and deployment for staging. Keep
`PIXIE_STAGING_ONLY_CHANNELS` set to a comma-separated allowlist so events from
production channels are dropped before routing.

## Environment

Copy `deploy/staging/env.staging.example` and fill it with staging-only values:

- Slack bot and app tokens for the staging app
- `PIXIE_STAGING_ONLY_CHANNELS` containing only staging channels
- model credentials
- a fresh `PIXIE_INTERNAL_TOKEN`
- a fresh database path on the staging volume
- the staging workspace and administrator IDs

Never reuse a production database or production-only channel allowlist.

## Onboarding

Open the dashboard onboarding flow against the staging Core database. Create a
staging program with a help channel and, when tickets are enabled, an organizer
channel. Activate it only after the bot is present in those channels. The
dashboard syncs the private configuration to the staging database.

## Verification

Confirm that the process connects, `/api/health` is clean, and a covered
question receives an answer from the configured source. Check that an event
outside the allowlist is ignored, unsupported questions follow the configured
ticket policy, and learned answers remain in the staging database.

## Teardown

Stop or remove only the staging deployment, its volume, and its staging Core
database. Production is unaffected when the allowlist and database are separate.
