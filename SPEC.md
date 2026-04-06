# whygent format spec v0.3

Semantic memory protocol for AI agents working in codebases.
Lives alongside git in `.whygent/`. Does not replace git.

---

## Directory layout

```
.whygent/
  config.json          ← repo-level metadata and spec version
  index.jsonl          ← one line per session (lightweight summary)
  current              ← session_id of the active session (absent when idle)
  lock                 ← advisory write lock (PID of current writer)
  sessions/
    <session-id>.jsonl ← events for that session
```

`session-id` format: `YYYY-MM-DDTHHMMSS-<8-char-hex>` — e.g. `2026-03-31T104217-a3f2c801`

The 8-char hex suffix is randomly generated at session creation to avoid collisions in parallel environments.

---

## config.json

Written once on `whygent init`. Never updated automatically.

```jsonc
{
  "spec_version": "0.3",
  "created_at": "2026-03-31T10:42:17Z"
}
```

Readers must check `spec_version` before parsing. If the version is higher than what the reader supports, warn and degrade gracefully. Unknown fields in any whygent file must be silently ignored — the format is forward-compatible.

---

## current

Plain text file containing a single `session_id`. Created by `whygent begin`, deleted by `whygent close`.

```
2026-03-31T104217-a3f2c801
```

Any tool that needs to write to the active session reads this file to resolve the session file path.

**Detecting abnormal termination:** if `current` exists but the referenced session file has **no `close` event**, the session ended abnormally — treat it as `interrupted`. If `current` exists and the session file does have a `close` event, the session closed cleanly but `current` was not deleted (e.g. the process was killed after writing `close` but before deleting `current`). In this case, delete `current` and proceed normally.

`current` is protected by the advisory lock (same as `index.jsonl`) to prevent two concurrent `whygent begin` calls from racing.

---

## Advisory locking

Before writing to `index.jsonl` or `current`, writers must acquire the lock:

1. Create `.whygent/lock` atomically using `O_CREAT | O_EXCL` (or equivalent). Write the writer's PID into the file.
2. If creation fails because the file already exists, read the PID from the file and check if that process is still alive. If not alive, delete the stale lock and retry from step 1. If alive, wait and retry.
3. Perform the write(s) to `index.jsonl` and/or `current`.
4. Delete `.whygent/lock`.

The `O_CREAT | O_EXCL` combination is atomic on POSIX filesystems — only one process will succeed in creating the file. This is not crash-safe (a writer that dies mid-write leaves a corrupt last line in `index.jsonl`), but it prevents interleaving. Writers should validate that the last line of `index.jsonl` is valid JSON before appending; if not, run `whygent repair` first.

Session files (`sessions/*.jsonl`) are written by a single session owner and do not require locking.

---

## index.jsonl

One line per session. Used for fast queries without reading full session files. This is a **derived cache** — it can always be rebuilt from session files via `whygent repair`.

The index is append-only. When a session is updated (e.g. `close` is written), a new line is appended with the same `session_id` and a higher `index_version`. Readers must treat the line with the highest `index_version` for a given `session_id` as authoritative and ignore earlier lines. `whygent repair` deduplicates and rewrites the index with one line per session.

```jsonc
{
  "session_id": "2026-03-31T104217-a3f2c801",
  "index_version": 1,             // incremented each time this session's entry is updated
  "started_at": "2026-03-31T10:42:17Z",
  "closed_at": "2026-03-31T11:15:03Z",  // null if outcome is "in_progress" or "interrupted"
  "agent": {
    "tool": "claude-code",              // self-reported by the agent
    "model": "claude-sonnet-4-6"        // null if unknown
  },
  "git_head": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",  // full SHA-1, null if no commits
  "intent": "Refactor auth middleware to use JWT",
  "outcome": "completed",              // "completed" | "partial" | "abandoned" | "interrupted" | "in_progress"
  "outcome_note": "Skipped refresh token logic, left TODO",  // optional
  "files": ["src/auth.ts", "src/middleware.ts"],  // flat path list, derived from all session events
  "tags": ["auth", "refactor"]         // optional, agent-defined
}
```

`files` in the index is the union of all `path` values from all `files` arrays across all events in the session. This is the canonical derivation rule — `whygent repair` and `whygent close` must produce identical lists using this rule.

---

## sessions/<session-id>.jsonl

One line per event, in chronological order. Each event shares a common envelope:

```jsonc
{
  "session_id": "2026-03-31T104217-a3f2c801",
  "seq": 0,
  "type": "<event-type>",
  "at": "2026-03-31T10:42:17Z",
  // ... type-specific fields
}
```

`seq` is zero-indexed and monotonically increasing within a session. Because session files are written by a single owner, seq can be determined by reading the last line of the file before appending.

### Event types

#### `begin`

Opens a session. Always seq 0.

```jsonc
{
  "type": "begin",
  "intent": "Refactor auth middleware to use JWT",
  "context": "User reported that session tokens are stored insecurely. Legal flagged it.",
  "git_head": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",  // full SHA-1. null if no commits.
  "resumed_from": null   // session_id this continues, or null
}
```

`resumed_from` is informational. The referenced session should have `outcome: "interrupted"`, but this is not enforced. Multiple sessions may reference the same `resumed_from` (e.g. two agents independently resuming the same interrupted work). There is no `resumed_by` pointer in the original session — to find all continuations, search the index for `resumed_from: <session_id>`.

#### `note`

Mid-session checkpoint. General observation or progress update.

```jsonc
{
  "type": "note",
  "body": "The middleware chain has an undocumented order dependency between cors and auth.",
  "files": [
    { "path": "src/middleware.ts", "base_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "dirty": false }
  ]
}
```

#### `decision`

An explicit choice made — what was chosen and why. Primary target of `whygent why <file>`.

```jsonc
{
  "type": "decision",
  "body": "Using RS256 instead of HS256 because the public key needs to be shareable with the mobile client.",
  "alternatives": [
    { "option": "HS256", "reason_rejected": "Requires sharing the secret with the mobile client." }
  ],
  "files": [
    { "path": "src/auth.ts", "base_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "dirty": false }
  ]
}
```

#### `attempt`

Something tried, with outcome. Captures failed approaches so future agents don't repeat them.

```jsonc
{
  "type": "attempt",
  "body": "Tried moving token validation to a Fastify hook instead of middleware.",
  "outcome": "failed",    // "succeeded" | "failed" | "partial"
  "reason": "Hook runs after route handler in this version of Fastify, too late for auth.",
  "files": [
    { "path": "src/hooks/auth.ts", "base_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "dirty": true }
  ]
}
```

#### `uncertainty`

Something the agent doesn't know or isn't confident about. Explicit signal for future agents.

```jsonc
{
  "type": "uncertainty",
  "body": "Not sure if the token blacklist is checked anywhere else. Searched and found nothing, but the pattern is inconsistent.",
  "files": [
    { "path": "src/auth.ts", "base_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "dirty": false }
  ]
}
```

#### `close`

Closes the session. Must be the last event.

```jsonc
{
  "type": "close",
  "outcome": "partial",    // "completed" | "partial" | "abandoned" | "interrupted"
  "outcome_note": "JWT validation done. Refresh token logic not started — see uncertainty event above.",
  "files": [
    { "path": "src/auth.ts", "base_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "dirty": false },
    { "path": "src/middleware.ts", "base_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "dirty": false }
  ]
}
```

Use `interrupted` when closing uncleanly (context limit hit, agent shutting down mid-task). A future session may set `resumed_from` to this session's id.

**Sessions with no `close` event** (process killed before close could be written) are treated as `interrupted` by `whygent repair`. The repair command synthesizes a minimal index entry with `outcome: "interrupted"` and `closed_at: null`.

---

## File reference

Used in `files` arrays across all event types.

```jsonc
{
  "path": "src/auth.ts",
  "base_commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",  // full SHA-1. null if no commits.
  "dirty": false
}
```

`base_commit` is always a full 40-character SHA-1. Abbreviated hashes are not valid — they are not stable as repos grow.

When `dirty: true`, `base_commit` is the last commit before the uncommitted changes. It does not describe the actual file state. Consumers can use `git show <base_commit>:<path>` to retrieve the last committed version, but cannot recover the dirty state from this record alone. This is a known limitation.

---

## CLI commands (reference)

All commands that write events accept `--file <path>` (repeatable) to add file references to the event. If inside a git repo, the CLI automatically resolves `base_commit` (current HEAD) and `dirty` (whether the file has uncommitted changes) for each specified path.

| Command | Description |
|---|---|
| `whygent init` | Initialize `.whygent/` in the current repo |
| `whygent begin "<intent>" [--context "<text>"] [--resume <session-id>]` | Open a new session |
| `whygent note "<text>" [--file <path>]` | Add a note to the current session |
| `whygent decision "<text>" [--file <path>]` | Record a decision |
| `whygent attempt "<text>" --outcome <outcome> [--file <path>]` | Record an attempt |
| `whygent uncertainty "<text>" [--file <path>]` | Flag an uncertainty |
| `whygent close [--outcome <outcome>] [--note "<text>"]` | Close the current session |
| `whygent why <file>` | Show `decision` events that reference a file |
| `whygent why <file> --mentions` | Show all events that reference a file |
| `whygent query "<text>"` | Search `intent` and `outcome_note` across the index |
| `whygent query "<text>" --deep` | Also search all event `body` fields in session files |
| `whygent log` | List recent sessions from index |
| `whygent repair` | Rebuild and deduplicate `index.jsonl` from session files |

`whygent query` performs case-insensitive substring matching against `intent` and `outcome_note` in `index.jsonl`. `--deep` additionally searches `body` fields in all session event files. No fuzzy or semantic matching — exact substring only in v0.3.

If `whygent close` is called without `--outcome`, it prompts interactively. If stdout is not a TTY (e.g. called from a script or agent), `--outcome` is required.

---

## Design principles

1. **The format is the product.** The CLI is a convenience. Any agent can read and write `.whygent/` directly by following this spec.
2. **Self-reported, not verified.** Agent identity is declared, not authenticated. Useful signal without enforcement.
3. **Append-only.** Session files are never edited after writing. The index is a derived cache and can always be rebuilt.
4. **Git-aware, not git-dependent.** Commit hashes are best-effort. whygent works in repos with no commits.
5. **Interrupted is not failed.** A session that ends due to context limits or process death is `interrupted`, not `abandoned`. The intent survived even if the session didn't.
6. **Forward-compatible.** Unknown fields are silently ignored. Readers that encounter an unsupported `spec_version` must warn and degrade, not crash.
