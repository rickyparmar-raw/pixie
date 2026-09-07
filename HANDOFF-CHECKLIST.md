# Handoff checklist — pixie to a new Railway account

Same Slack app, full state moved. The plan is deliberately boring: every step
verifiable before the next, the bot talks the whole time, and a smoke test catches
the things humans don't notice.

Estimated time: 30–45 minutes. Most of it is waiting on Railway.

> **One thing to know up front.** Your current deployment keeps answering the
> whole time. The handoff is a parallel run, not a cutover: bring the new
> project up alongside, verify it, then delete the old one. The `bot_name`
> and command prefix are the same on both sides, so even a brief overlap
> doesn't confuse Slack (command names are unique per workspace, and they're
> the same names on both projects, so what happens is the older one stops
> replying because Slack only routes a command to one app and the newer
> one took its place in the workspace).

---

## 0. Snapshot the current project

Before touching anything, capture state from the *current* Railway project so the
handoff is restorable.

- **Variables** — Railway dashboard → your current service → Variables tab →
  download or screenshot every variable. Don't trust the count, copy the
  actual values: each row's value, the `KEY=value` line as a whole, the
  order if it matters. (It does — see step 5 about `OPENCODE_API_KEY_N`.)
- **Volume mount path** — Settings → Volumes. Write down the volume name
  and the mount path (`/data` is the engine's contract).
- **Volume snapshot** (if your plan supports it) or `pgdump`/`restic` of
  `pixie.db`. The volume's contents are the only piece of state that isn't
  trivially recreated; the answer cache and learned facts are not critical,
  but the recent docs copy is.
- **Git SHA** — `git rev-parse HEAD` in the engine repo. The new project
  should pin to the same SHA, not `main`, until you've verified.

`scripts/migrate-railway.js` writes `current-env.json` to make the next step
mechanical rather than a copy-paste.

---

## 1. Set up the new Railway account

1. Sign in to the new Railway account.
2. Connect that account's GitHub app to `rickyparmar-raw/PIXIE`. This is the
   single step most likely to be forgotten. A missing connection fails
   `serviceCreate` mid-provision with an opaque Railway error and the
   current project keeps running.
3. Add a payment method and plan (Hobby works; Free works for low volume
   but has limits).

---

## 2. Create the new project

1. New Project → Deploy from GitHub repo → `rickyparmar-raw/PIXIE`.
2. Pin to a **specific commit SHA**, not `main`. Two reasons:
   - the new project is identical to the old one byte-for-byte
   - if `main` moves between steps, you don't suddenly deploy an
     unverified change
3. **Before** the first deploy finishes: Settings → Volumes → Add Volume →
   mount at `/data`. The engine opens SQLite on boot; a volume attached
   *after* the first deploy means the first run wrote to a path that
   then vanished, and you'll be debugging a "bot can't write its database"
   failure at the worst time.

---

## 3. Write the env (most error-prone step)

Use `bun run migrate --write ./current-env.json` from `pixie-wizard/` once
it's pointed at the new project. The script does a per-var diff before
writing and aborts on any unexpected key — no surprise overwrites. The
checklist is the manual version.

**Every key from the current project must be present and identical.** The
ones that bite the hardest when missed:

| Variable | What goes wrong if missing |
|---|---|
| `SLACK_BOT_TOKEN` | Bot won't connect; process exits in 1 second |
| `SLACK_APP_TOKEN` | Same |
| `SLACK_HELP_CHANNEL` | Process refuses to start — "missing required env" |
| `SLACK_FAQ_CHANNELS` | Same |
| `OPENCODE_API_KEY` | Same |
| `OPENCODE_API_KEY_2`, `_3`, ... | The engine's rotating pool drops back to one key; the bot looks broken under rate limit. **Order matters** — these are numbered from `_2`, not by the key's order in your secrets store |
| `PIXIE_PROGRAMS_JSON` | Sources, channels, posture, scope, guides, milestones all fall back to the image's `programs.json` and `sources.json` — and the image's sources are Pixl's, so a Solvable bot answers Pixl questions |
| `PIXIE_DB_PATH` | Defaults to `./pixie.db` next to the code, which lives on the container filesystem. Without `/data` here, every redeploy wipes the answer cache, learned facts, ticket records, last-good docs copy |
| `PIXIE_ADMIN_USER_IDS` | Fails closed. Empty means nobody can teach the bot anything. **If your HCA identity isn't linked to a Slack ID, this is unset and the bot will be unable to teach, even to you.** |

Verify with `bun run migrate --check` — the script will print a per-key
"ok / missing / mismatch" report and exit 1 if anything is off.

---

## 4. Volume handoff

Two approaches, in order of preference:

**Option A — point the new project at the same volume** (if the new account
is in the same Railway workspace, which it isn't, but if it is): skip this
step.

**Option B — copy the volume contents.** Easiest: spin down the old
service, `pg_dump`-style copy `pixie.db` somewhere, attach a fresh volume
to the new project, copy the file in via `railway run bun ...` or a
one-off exec into the new service. The format is just SQLite; no
migration.

If the new account is genuinely separate and you don't have volume access
from outside Railway, do this:
- Old service: `railway shell` and `sqlite3 /data/pixie.db ".backup /tmp/dump.db"`
- Download `/tmp/dump.db` to your machine
- New service: attach a fresh volume at `/data`, `railway shell` again,
  push the file in (`cat dump.db | railway run --service new sh -c "cat > /data/pixie.db"`)
- Set ownership if needed: `railway run --service new chown 1000:1000 /data/pixie.db`

**After the copy, the new service must see the file before its first
deploy.** That's why step 2 says "attach the volume before first deploy":
the engine writes to that path on boot, and if it doesn't exist, it
crashes. Restore-into-existing-volume is fine; the engine only writes,
not recreates.

---

## 5. Deploy the new service

1. First deploy runs. Watch the logs for `connected via Socket Mode as
   U...` — that line is the "it works" signal.
2. The new service binds no port, so Railway shows no healthcheck. Slack
   Socket Mode is the connection.
3. If the deploy fails, the log usually says why:
   - `missing required environment variable` — go to step 3
   - `Railway API error` on a service action — GitHub connection missing,
     go to step 1
   - `port already in use` / healthcheck failure — unusual for this app;
     check the Dockerfile

---

## 6. Smoke test the new service

`bun run smoke-test` from `pixie-wizard/` once it's pointed at the new
project. It runs three things, in order:

1. A known-good question (e.g. "how do I submit a project") and asserts
   the bot's answer mentions the right program.
2. A question the docs don't cover (e.g. "what is the meaning of life")
   and asserts the bot's reply routes to the chat fallback rather than
   hallucinating.
3. `bot.name` from `auth.test` — confirms it's the same Slack app and
   not a re-install.

**If any of these fail, the new service is not ready. Do not delete the
old one yet.** The smoke test is the entire reason this works.

---

## 7. Cut over

Once the smoke test is green:

1. **Pause** the old Railway service (don't delete yet). The Slack app
   routes commands to the most recently active install, but the safest
   cutover is to flip the order explicitly: stop the old service first,
   watch the new one for a few minutes.
2. Watch for incoming questions in the help channel. The new service
   should pick them up.
3. After a few hours of clean operation, **delete** the old service.
   Don't leave it running "just in case" — two bots with the same
   commands in the same workspace is a race condition, not a safety net.

---

## 8. After

- The old Railway project is no longer in use. Delete the project, not
  just the service, so the volume goes with it.
- The new project is now the source of truth. Update any
  `PIXIE_WIZARD_ALLOWLIST` or admin list to reference the new Railway
  workspace if those checks live in the wizard.
- If you ever need to do this again: the same checklist applies. The
  volume is the only thing that has to move; everything else is in env
  vars you can copy.

---

## The two things most likely to go wrong

**1. Volume attached after first deploy.** The engine opens SQLite on
boot. If `/data/pixie.db` doesn't exist yet, the process crashes
silently. Always attach the volume *before* the first deploy, or
restore the file into a freshly-attached volume before triggering a
redeploy.

**2. `OPENCODE_API_KEY_2` numbering.** The engine reads the key by
suffix, not by env-var order. A key you labelled "extra" in the
dashboard but didn't suffix with `_2` is silently dropped, and the
bot looks broken under rate limit even though you "added" the key.
Verify with `bun run migrate --check`.

---

## Sources

- [Railway volume management API](https://docs.railway.app/integrations/api/manage-volumes) — for the `createVolume` step
- [Railway env vars and variables tab](https://docs.railway.com/variables) — for the per-var export
- [Slack Socket Mode](https://api.slack.com/apis/socket-mode) — for the "it connects without a domain" guarantee
