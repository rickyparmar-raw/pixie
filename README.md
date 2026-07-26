# Pixie

A Slack bot that answers questions grounded in the Pixl FAQ and docs, across whichever channels it's configured to watch (e.g. `#pixl-help`, `#pixl`). It's a separate app from [Pixorpheus](../pixorpheus) — pixie only answers questions from documentation; it does not touch tickets, claiming, or resolving. Both bots can run in the same channel at once.

## How it works

Pixie answers in three ways:

- **The help channel (`SLACK_HELP_CHANNEL`, always responds):** every top-level message there is inherently a real question (that's what the channel is for, and pixorpheus opens a ticket for each one), so pixie always replies — a grounded doc answer, or the neutral "not sure, ask a helper" fallback if it's not covered. Never silent here.
- **Other watched channels (`SLACK_FAQ_CHANNELS`, silent if uncovered):** top-level messages get checked automatically, but pixie only replies if the docs actually cover it — stays completely silent otherwise, since these are more general channels where not every message is a real question.
- **Plain-text name mention or real `@`-mention, anywhere:** saying "pixie" in a message (or a real `@`-ping) works outside the two channel lists above too. A real `@`-mention always responds (doc answer or fallback), same as the help channel. A plain-text name mention (no real `@`) is treated like the "silent if uncovered" case — a weak signal of intent (e.g. "pixie bye" shouldn't get a response). The plain-text name check is a free local regex, not an AI call, so it adds no latency to messages that don't mention pixie.

Every check sends the question plus the whole knowledge corpus to an LLM in one call, instructed to answer **only** from the provided docs. Each message is answered at most once.

## Knowledge base — adding docs

Everything pixie knows lives in [`sources.json`](./sources.json). Each entry is fetched fresh on startup and every `REFRESH_INTERVAL_MIN` minutes (default 30). If a source fails to fetch, pixie keeps serving the last version it successfully loaded instead of dropping it.

To add a new doc, add an entry:

```json
{ "name": "Getting Started Guide", "type": "gdoc", "url": "https://docs.google.com/document/d/<id>/export?format=txt" }
```

Supported `type`s:

| Type | What it expects | Notes |
|---|---|---|
| `json-faq` | A URL to the landing site's dictionary JSON | Extracts `faq.items[].question` / `.answer` |
| `gdoc` | A public Google Doc export URL (`.../export?format=txt`) | Doc must be shared as "anyone with the link can view" |
| `url` | Any web page or raw text/markdown URL | HTML is stripped to plain text |

No embeddings or vector DB — the whole corpus is small enough to pass straight into the model's context, which keeps answers exact and avoids retrieval mismatches. If the corpus grows large enough that this stops being cheap, that's the point to revisit.

### Deep links in replies

For `url`-type sources, if a page wraps sections in an anchored container (e.g. `<section id="react-native"><h1>React Native app guide</h1>...`), pixie automatically picks that up and links to the exact section (`https://.../docs#react-native`) when it cites that section — turning "from the React Native app guide" into a clickable link in the reply, instead of just a name. This is a code-level lookup (`knowledge.getSourceUrl()`), not something the model generates itself, so a broken/hallucinated link isn't possible — if there's no matching anchor for what's cited, it just falls back to plain text (e.g. FAQ answers, which have no per-item URL to link to).

## Environment Variables

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token for pixie's own Slack app (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_HELP_CHANNEL` | Channel ID that always responds to every top-level message (e.g. `#pixl-help`) |
| `SLACK_FAQ_CHANNELS` | Comma-separated channel IDs that get silent-if-uncovered checking (e.g. `#pixl`) |
| `OPENCODE_API_KEY` | API key for [OpenCode Zen](https://opencode.ai/zen) |
| `OPENCODE_BASE_URL` | Optional override, defaults to `https://opencode.ai/zen/v1/chat/completions` |
| `PIXIE_MODEL` | Optional override, defaults to `deepseek-v4-flash-free` |
| `REFRESH_INTERVAL_MIN` | Optional, how often to re-fetch docs (default `30`) |

Pixie currently calls OpenCode Zen's OpenAI-compatible `/chat/completions` endpoint, which is what `deepseek-v4-flash-free` (and most non-Claude Zen models) use. Claude models on Zen are served from a separate `/messages` (Anthropic format) endpoint instead — switching `PIXIE_MODEL` to a Claude model requires also changing `lib/answer.js` to call that endpoint.

## Slack App Setup

Pixie needs its own Slack app (separate from Pixorpheus), running in **Socket Mode** — no public URL, tunnel, or deployment required for events to reach it.

1. Create a new app at [api.slack.com/apps](https://api.slack.com/apps).
2. **OAuth scopes:** `chat:write`, `channels:history`, `groups:history`, `channels:join`, `app_mentions:read`.
3. **Socket Mode:** enable it, generate an App-Level Token with the `connections:write` scope (`xapp-...`).
4. **Event subscriptions:** enable events, subscribe to `message.channels`, `message.groups`, and `app_mention`. No Request URL needed once Socket Mode is on.
5. Install the app to the workspace. With `channels:join`, pixie can self-join any public channel listed in `SLACK_FAQ_CHANNELS` via the `conversations.join` API — no manual `/invite` needed for public channels (private channels still need a manual invite).
6. Copy the bot token (`xoxb-...`) and app-level token (`xapp-...`) into `.env`.

## Running

```bash
bun install
bun run start
```

### Offline test mode

Test what pixie would reply without connecting to Slack at all:

```bash
node index.js --ask "how do i join pixl?"
```

This builds the corpus from `sources.json` and prints the answer (or confirms pixie would stay silent) directly to the console — useful for checking new docs or auth before deploying.

## Tests

```bash
bun test
```

Covers the FAQ-JSON-to-corpus parsing and the model-reply parsing (`NONE` vs. a structured answer).
