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
cogitlog show <session-id>      # one session in full
```

`query` searches everything by default. Before 0.7 it only matched session intents,
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
| `query "<text>"` | Search everything: descriptions, bodies, rejected alternatives, tags |
| `status` | Show the current session status |
| `onboard` | Print usage instructions (useful to paste into agent context) |
| `hook install` | Install a post-commit hook that auto-closes sessions on `git commit` |
| `repair` | Rebuild `index.jsonl` from session files |

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
