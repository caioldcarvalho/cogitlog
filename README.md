# cogitlog

Semantic session memory for AI agents working in codebases.

cogitlog records what an AI agent did, decided, and why — stored alongside git history so future agents (and humans) can understand not just *what* changed but *why*.

## Install

```sh
npm install -g cogitlog
```

## Quick start

```sh
# In your project
cogitlog init

# At the start of every AI task
cogitlog begin "add dark mode toggle"

# During the task
cogitlog note "using CSS custom properties, not a theme provider"
cogitlog decision "store preference in localStorage, not a cookie" \
  -a "cookie:overkill for a UI-only setting"
cogitlog attempt "toggling class on <html>" --outcome failed \
  --reason "SSR mismatch on first render"
cogitlog uncertainty "not sure if prefers-color-scheme should override manual toggle"

# At the end
cogitlog close --outcome completed
```

## Reading someone else's log

Inheriting a repo that has a `.cogitlog/` is the case this exists for:

```sh
cogitlog log -d                 # every session, with one line per event
cogitlog query "dark mode"      # searches descriptions, bodies, rejected alternatives
cogitlog why src/theme.ts       # decisions that touched this file
cogitlog context src/theme.ts   # everything recorded about this file
cogitlog show <session-id>      # one session in full
```

`query` searches everything by default. Before 0.8 it only matched session intents,
so a store holding a full note about a topic answered `No results` when asked for it —
a failure that reads exactly like an empty repository. `--shallow` restores the old,
narrower search.

**You do not need this CLI to read a store.** `.cogitlog/sessions/*.jsonl` is plain
JSONL — one event per line, one file per session:

```sh
cat .cogitlog/sessions/*.jsonl | jq -r 'select(.type=="decision") | .body'
```

## Commands

| Command | Description |
|---|---|
| `init` | Initialize `.cogitlog/` — safe to re-run; repairs a missing index and refreshes instruction files |
| `remindme [--force]` | Write/refresh the cogitlog block in agent instruction files (CLAUDE.md, etc.) |
| `begin "<intent>"` | Open a new session |
| `note "<text>"` | Add a free-form note |
| `decision "<text>"` | Record a decision (supports `--alternative "option:reason"`) |
| `attempt "<text>" [<succeeded\|failed\|partial>]` | Record an attempt and its outcome |
| `uncertainty "<text>"` | Flag something you are not sure about |
| `close --outcome <completed\|partial\|abandoned\|interrupted>` | Close the current session |
| `log [-d]` | List recent sessions; `-d` adds one description line per event |
| `show [session-id]` | Show full detail of a session |
| `why <file>` | Show decisions that touched a file |
| `context <file>` | Show every event related to a file (`--brief` for the last 3 sessions) |
| `query "<text>"` | Search everything: descriptions, bodies, rejected alternatives, tags |
| `status` | Show the current session status |
| `onboard` | Print usage instructions (useful to paste into agent context) |
| `guard` | Print what to record when a commit has no reasoning logged (never fails) |
| `hook install [--remind]` | Post-commit hook to auto-close sessions; `--remind` adds the pre-commit reminder |
| `repair` | Rebuild `index.jsonl` from session files |
| `install-skills` | Install the `/cogitlog-read` and `/cogitlog-write` Claude Code commands |

Every event-writing command accepts `-d, --description "<one-line summary>"` and
`--relates-to <session-id>`. Without `-d`, the first line of a multi-line body becomes
the description. Descriptions are what `log -d` and `query` scan, so a store stays
navigable as it grows — the same property that makes a well-kept notebook usable.

## How it works

`cogitlog init` creates a `.cogitlog/` directory with:

- `index.jsonl` — lightweight index of all sessions (intent, outcome, files touched)
- `sessions/<id>.jsonl` — full event log per session
- `AGENTS.md` — instructions for agents that discover the directory

It also appends a usage reminder to any existing agent instruction files it finds (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, etc.).

Sessions are plain JSONL files — no server, no database.

## Integrating with your agent workflow

After `cogitlog init`, agents that read `CLAUDE.md` (or equivalent) will see the reminder automatically. For projects where cogitlog was initialized without an instruction file, run:

```sh
cogitlog remindme
```

This appends the reminder to any existing instruction files, or creates `CLAUDE.md` if none are found.

## License

MIT

## Reminders at commit time

```sh
cogitlog hook install --remind
```

Installs a `post-commit` hook that closes the open session, and a `pre-commit` hook that
prints the command to run when a commit carries no recorded reasoning:

```
cogitlog: nothing recorded for 3 files. To leave a trace:
  cogitlog begin "<what you set out to do>"
  cogitlog decision "<what you chose and why>" -f src/auth.ts -f src/session.ts
  (nothing worth recording? ignore this, or set COGITLOG_SKIP=1)
```

**It never fails a commit.** Not every commit deserves a session, and a hook that blocks
on a lockfile bump only teaches everyone to reach for `--no-verify`. Nobody else is
affected either: `.git/hooks` is not versioned, so cloning installs nothing, and the
script no-ops when `cogitlog` is not on `PATH`.

## Update notices

cogitlog checks the registry at most once a day, in a detached process, and mentions a
newer version on **stderr** — never stdout, which `--json` consumers parse. Disable with
`COGITLOG_NO_UPDATE_CHECK=1`, with `"update_check": false` in `.cogitlog/config.json`, or
let it stay quiet automatically under `CI`.
