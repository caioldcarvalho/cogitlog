# Changelog

## 0.8.0

Four defects, all observed during a real handover across four repositories — the
kind where someone inherits a codebase and has to find out what the last person knew.
Every one failed the same way: silently, in a manner indistinguishable from "this
repo has nothing recorded".

Format spec goes to **0.4**. The upgrade is additive; no store needs migrating.
See [SPEC.md](SPEC.md#compatibility).

### `query` no longer under-reports

`query <term>` matched only a session's `intent` and `outcome_note`. Everything of
substance — decision bodies, notes, attempts, uncertainties — was reachable only
with `--deep`. A store holding a full note about embeddings answered `No results`
for "embeddings", and a newcomer reasonably concluded the store was empty and
stopped using it.

Deep search is now the **default**, and it covers more than `--deep` ever did:
descriptions, bodies, rejected alternatives (`option` *and* `reason_rejected`),
`attempt.reason`, tags, and links. Rejected alternatives — the single most
expensive thing to reconstruct — were invisible to every search mode before this.

- `--shallow` restores the old index-only search.
- `--deep` is still accepted and ignored, so existing scripts and cogitlog-mcp keep working.
- An empty result now states what was searched instead of a bare `No results`.

### Every event carries a `description`

The one-line summary is what makes a large store navigable: read the descriptions,
open only what matters. Borrowed, deliberately, from the note systems that get this
right — and the same name they use.

- `-d, --description "<text>"` on `note`, `decision`, `attempt`, `uncertainty`.
- Without it, the first line of a multi-line body becomes the description — which
  applies to events written before 0.4 too, so old stores became scannable without
  being rewritten.
- Index entries now carry a `digest`: one description per event, so an entire store
  can be surveyed by reading `index.jsonl` alone.
- `log -d` prints the digest under each session. `show` leads with the description
  and no longer repeats it in the body.
- This is the root cause of the query defect: with no summary to match, a shallow
  search had nothing to work with.

### Events can point at other sessions

`--relates-to <session-id>`, repeatable, plus `[[session-id]]` parsed from the body.
A decision can now name the one it supersedes. Links are searchable and shown by
`show`; the index carries their union.

### `init` teaches reading, not just writing

The block written into `CLAUDE.md` / `AGENTS.md` / `.cursorrules` explained only how
to *record*. The half that matters to whoever inherits the repo — how to *read* it —
was missing, along with the fact that reading needs no installation at all.

The block now leads with `why` / `query` / `log -d` / `show`, states that
`.cogitlog/sessions/*.jsonl` is plain JSONL readable with no tooling, and says
plainly why to read before editing: an `attempt … failed` entry exists to stop the
next person from walking back into the same dead end.

The block is also **managed** now, between `<!-- cogitlog:begin -->` / `<!-- cogitlog:end -->`
markers. Previously any file that so much as mentioned "cogitlog" was skipped
forever, which froze every already-initialized repo on the old text permanently.
Legacy `## cogitlog` sections are replaced in place, leaving the rest of the file
untouched; a file that mentions cogitlog outside a managed block is left alone
unless you pass `--force`.

`init` is now safe to re-run: it repairs a missing index and refreshes the blocks.

### A store with no index says so

A `.cogitlog/` created by an old version has only `sessions/`. Every read command
answered `No sessions` — with 17 intact session files on disk. `cogitlog repair`
fixed it instantly, but nothing ever suggested running it.

Read commands now compare the session files against the index:

- **index missing or empty** → rebuilt in place, with a note. Nothing is lost,
  because an absent index holds nothing.
- **index incomplete** → a warning with both counts, pointing at `cogitlog repair`.
  Not rebuilt silently: `tags` exist only in the index and a rebuild would discard them.
- Healing is best-effort. On a read-only store the entries are derived in memory
  and the command still succeeds.

`repair` now preserves `tags` and `index_version` from the existing index, and
backfills `digest` and `links`.

### Also

- `close` derives `index_version` from the existing entry instead of hardcoding `2`.
- `why` and `context` suggest `query` when a file has no recorded history.
- `status` reports the session count when idle.

### Note on 0.7.0

0.7.0 added `cogitlog context` and a reading-first hint block. This release keeps both
and goes further: `context` now uses descriptions, sorts newest-first, takes `-n`, and
drops the `close` events that used to match nearly every file. The hint block gained
markers, the "no install needed" fact, and the reason to read before editing.

## 0.7.0

- `cogitlog context <file>` — all reasoning related to a file, with `--brief`.
- Reading commands listed in the generated instruction block.
- `remindme --force` to replace an existing section.
- Claude Code integration: session hooks and `install-skills`.
- Path normalization so `./src/a.ts` and `src/a.ts` match.
