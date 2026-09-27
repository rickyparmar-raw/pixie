# Setting up a bot

Pixie is a program-agnostic engine. The public repository contains no program
identity or documentation. Add a program through the dashboard, or supply the
same configuration privately when self-hosting.

## Dashboard onboarding

Use the dashboard onboarding flow to create a program and connect it to Pixie.
Provide the program name, support identity, Slack channels, behavior settings,
and documentation sources. The dashboard syncs the result through Core into
the program database. The bot then loads those sources and keeps learned
answers scoped to that program.

The dashboard is the recommended path for hosted deployments. It keeps secrets,
channel ownership, and program configuration outside this public repository.

## Operator configuration

An operator can run the engine with private files instead. Create
`config/programs.json` with an array of program records and optionally create
`config/sources.json` for shared sources. `file://` source URLs are resolved
under the application root. These files are intentionally absent from the
public repository.

The environment variable `PIXIE_PROGRAMS_JSON` accepts the same array, or an
object containing a `programs` array. It takes precedence over the local
program file when present. If neither the environment variable nor local files
provide programs, Pixie starts with no configured programs and no shipped
knowledge.

Example private configuration:

```json
[
  {
    "id": "example",
    "name": "Example",
    "scope": "program",
    "helpChannel": "C_HELP",
    "channels": ["C_HELP"],
    "sources": [
      {
        "name": "Example docs",
        "type": "url",
        "url": "https://example.invalid/docs"
      }
    ]
  }
]
```

## Verify

Run `bun index.ts --ask "your question"` after configuring a source. In Slack,
use the configured sources command to inspect source status. Teachings,
resolved-ticket learning, and answer caches are stored in the configured
database and remain scoped to their program.
