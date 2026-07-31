# cogitlog format spec v0.4

Semantic memory protocol for AI agents working in codebases.
Lives alongside git in `.cogitlog/`. Does not replace git.

---

## Directory layout

```
.cogitlog/
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

Written once on `cogitlog init`. Never updated automatically.

```jsonc
{
  "spec_version": "0.4",
  "created_at": "2026-03-31T10:42:17Z"
}
```

Readers must check `spec_version` before parsing. If the version is higher than what the reader supports, warn and degrade gracefully. Unknown fields in any cogitlog file must be silently ignored — the format is forward-compatible.

---

## current

Plain text file containing a single `session_id`. Created by `cogitlog begin`, deleted by `cogitlog close`.

```
2026-03-31T104217-a3f2c801
```

Any tool that needs to write to the active session reads this file to resolve the session file path.

**Detecting abnormal termination:** if `current` exists but the referenced session file has **no `close` event**, the session ended abnormally — treat it as `interrupted`. If `current` exists and the session file does have a `close` event, the session closed cleanly but `current` was not deleted (e.g. the process was killed after writing `close` but before deleting `current`). In this case, delete `current` and proceed normally.

`current` is protected by the advisory lock (same as `index.jsonl`) to prevent two concurrent `cogitlog begin` calls from racing.

---

## Advisory locking

Before writing to `index.jsonl` or `current`, writers must acquire the lock:

1. Create `.cogitlog/lock` atomically using `O_CREAT | O_EXCL` (or equivalent). Write the writer's PID into the file.
2. If creation fails because the file already exists, read the PID from the file and check if that process is still alive. If not alive, delete the stale lock and retry from step 1. If alive, wait and retry.
3. Perform the write(s) to `index.jsonl` and/or `current`.
4. Delete `.cogitlog/lock`.

The `O_CREAT | O_EXCL` combination is atomic on POSIX filesystems — only one process will succeed in creating the file. This is not crash-safe (a writer that dies mid-write leaves a corrupt last line in `index.jsonl`), but it prevents interleaving. Writers should validate that the last line of `index.jsonl` is valid JSON before appending; if not, run `cogitlog repair` first.

Session files (`sessions/*.jsonl`) are written by a single session owner and do not require locking.

---

## index.jsonl

One line per session. Used for fast queries without reading full session files. This is a **derived cache** — it can always be rebuilt from session files via `cogitlog repair`.

The index is append-only. When a session is updated (e.g. `close` is written), a new line is appended with the same `session_id` and a higher `index_version`. Readers must treat the line with the highest `index_version` for a given `session_id` as authoritative and ignore earlier lines. `cogitlog repair` deduplicates and rewrites the index with one line per session.

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
  "tags": ["auth", "refactor"],        // optional, agent-defined
  "digest": [                          // 0.4+. One line per event. Absent on entries written by 0.3.
    { "seq": 1, "type": "decision", "description": "RS256 over HS256 — public key must be shareable" },
    { "seq": 2, "type": "attempt",  "description": "token validation as a Fastify hook" }
  ],
  "links": ["2026-03-30T091500-77c1e0aa"]  // 0.4+. Union of every event's `links`, plus `resumed_from`.
}
```

`files` in the index is the union of all `path` values from all `files` arrays across all events in the session. This is the canonical derivation rule — `cogitlog repair` and `cogitlog close` must produce identical lists using this rule.

`digest` exists so an entire store can be scanned — "what is in here?" — by reading `index.jsonl` alone, without opening a single session file. It holds one `description` per event, excluding `begin` and `close` (whose summaries are already `intent` and `outcome_note`). It is derived, like `files`: `cogitlog repair` rebuilds it for stores written before 0.4.

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

### Prose fields (0.4+)

Every event that carries a `body` — `note`, `decision`, `attempt`, `uncertainty` — may also carry:

```jsonc
{
  "description": "RS256 over HS256 — public key must be shareable",  // one-line summary, or null
  "links": ["2026-03-30T091500-77c1e0aa"]                            // session ids this event points at
}
```

**`description`** is the one-line summary that `query`, `log -d` and `show` scan. It is what makes a store of hundreds of events navigable: read the descriptions, open only what matters.

Both fields are optional and may be absent entirely — events written before 0.4 have neither. Readers **must** compute a description when the field is missing or null, by taking the first line of `body` (truncated to 120 characters). This is what keeps pre-0.4 stores scannable without rewriting them. Writers should store `description` only when it differs from that fallback: an explicit `-d`, or the first line of a multi-line body.

**`links`** records that this event refers to another session — the decision it supersedes, the interrupted work it picks up. Writers populate it from `--relates-to` and from any `[[session-id]]` appearing in the body. Links are informational and one-directional; there is no back-pointer. To find what points at a session, search the index for its id.

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

An explicit choice made — what was chosen and why. Primary target of `cogitlog why <file>`.

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

**Sessions with no `close` event** (process killed before close could be written) are treated as `interrupted` by `cogitlog repair`. The repair command synthesizes a minimal index entry with `outcome: "interrupted"` and `closed_at: null`.

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
All commands that write prose events also accept `--description <text>` (`-d`) and `--relates-to <session-id>` (repeatable).

| Command | Description |
|---|---|
| `cogitlog init` | Initialize `.cogitlog/` — safe to re-run; repairs a missing index and refreshes instruction files |
| `cogitlog begin "<intent>" [--context "<text>"] [--resume <session-id>]` | Open a new session |
| `cogitlog note "<text>" [-d "<summary>"] [--file <path>]` | Add a note to the current session |
| `cogitlog decision "<text>" [-a "<option:reason>"] [-d "<summary>"]` | Record a decision |
| `cogitlog attempt "<text>" [<outcome>] [--reason "<text>"]` | Record an attempt (outcome defaults to `succeeded`) |
| `cogitlog uncertainty "<text>" [-d "<summary>"]` | Flag an uncertainty |
| `cogitlog close [--outcome <outcome>] [--note "<text>"]` | Close the current session |
| `cogitlog why <file>` | Show `decision` events that reference a file |
| `cogitlog why <file> --mentions` | Show all events that reference a file |
| `cogitlog query "<text>"` | Search every session — descriptions, bodies, alternatives, tags, links |
| `cogitlog query "<text>" --shallow` | Index only: `intent`, `outcome_note`, `tags`, `digest` |
| `cogitlog log [-d]` | List recent sessions; `-d` adds one description line per event |
| `cogitlog repair` | Rebuild `index.jsonl` from session files; backfills `digest` and `links` |
| `cogitlog remindme [--force]` | Write/refresh the cogitlog block in agent instruction files |

`cogitlog query` performs case-insensitive substring matching — no fuzzy or semantic matching. As of 0.4 it searches everything by default: index fields, every event `description` and `body`, `alternatives` (both `option` and `reason_rejected`), `attempt.reason`, tags, and links. `--shallow` restricts it to the index. `--deep` is accepted and ignored — it is what the full search used to be called.

The default changed because the narrow default failed silently: a store containing a full note about a topic answered `No results` when queried for it, which is indistinguishable from an empty store. A search that under-reports is worse than a slow one.

If `cogitlog close` is called without `--outcome`, it prompts interactively. If stdout is not a TTY (e.g. called from a script or agent), `--outcome` is required.

---

## Index health

`index.jsonl` is a derived cache, and a store whose index is missing is still a complete store — the session files hold everything. Readers must therefore not equate an empty index with an empty store.

Before reading the index, a reader compares the session ids in `sessions/` against those in `index.jsonl`:

| State | Meaning | Required behavior |
|---|---|---|
| index covers every session file | healthy | proceed |
| `sessions/` non-empty, index missing or empty | store predates the index, or the index was lost | rebuild it in place — nothing is lost, since an absent index holds no information |
| index exists but omits some session files | index is stale | report the counts and point at `cogitlog repair` — do **not** rebuild silently, because `tags` exist only in the index and would be discarded |

The distinction matters: rebuilding is lossless only when there is nothing to lose. `tags` are the one field with no source outside the index, so a rebuild over a populated index must be an explicit user action.

---

## Compatibility

**0.3 → 0.4** is additive. Every new field — `description` and `links` on events, `digest` and `links` on index entries — is optional, and 0.3 readers ignore unknown fields by rule (see *Forward-compatible* below). A 0.4 store is readable by a 0.3 reader with no loss beyond the new fields themselves.

In the other direction, a 0.3 store is fully usable by a 0.4 reader: missing descriptions are derived from the first line of `body` at read time, so old events are scannable without being rewritten. Only the index `digest` needs materializing, and `cogitlog repair` does it in one pass. Running it is optional — it makes `--shallow` queries and `log -d` faster on old sessions, nothing more.

Session files are never rewritten by an upgrade. Existing events keep the exact bytes they were written with.

---

## Design principles

1. **The format is the product.** The CLI is a convenience. Any agent can read and write `.cogitlog/` directly by following this spec.
2. **Self-reported, not verified.** Agent identity is declared, not authenticated. Useful signal without enforcement.
3. **Append-only.** Session files are never edited after writing. The index is a derived cache and can always be rebuilt.
4. **Git-aware, not git-dependent.** Commit hashes are best-effort. cogitlog works in repos with no commits.
5. **Interrupted is not failed.** A session that ends due to context limits or process death is `interrupted`, not `abandoned`. The intent survived even if the session didn't.
6. **Forward-compatible.** Unknown fields are silently ignored. Readers that encounter an unsupported `spec_version` must warn and degrade, not crash.
