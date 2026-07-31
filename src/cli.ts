#!/usr/bin/env node
import { Command } from 'commander'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import readline from 'readline'

import { AGENT_TOOL, SPEC_VERSION, findVibegitDir, requireVibegitDir, vgPaths } from './vg'
import {
  appendEvent,
  appendIndex,
  buildEntriesFromSessions,
  checkIndexHealth,
  clearCurrentId,
  describeEvent,
  deriveDigest,
  deriveFiles,
  deriveLinks,
  getCurrentId,
  nextSeq,
  parseInlineLinks,
  readEvents,
  readIndex,
  rebuildIndex,
  resolveInterrupted,
  setCurrentId,
} from './io'
import { autoFileRefs, getGitRoot, getHead, resolveFileRefs } from './git'
import type { AttemptOutcome, FileRef, IndexEntry, SessionEvent, SessionOutcome } from './types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString()
}

function makeSessionId(): string {
  const d = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${ts}-${crypto.randomBytes(4).toString('hex')}`
}

function collect(val: string, acc: string[]): string[] {
  return [...acc, val]
}

function requireActiveSession(vgDir: string): string {
  resolveInterrupted(vgDir)
  const p = vgPaths(vgDir)
  const id = getCurrentId(p.current)
  if (!id) {
    console.error('No active session. Run `cogitlog begin "<intent>"` first.')
    process.exit(1)
  }
  return id
}

function fileRefs(explicitFiles: string[], gitRoot: string | null): FileRef[] {
  if (explicitFiles.length > 0) return resolveFileRefs(explicitFiles, gitRoot)
  return autoFileRefs(gitRoot)
}

/**
 * The one-line description stored on an event.
 *
 * Null when the body already is its own summary — readers fall back to the first
 * line of the body, so there is nothing to gain from duplicating it on disk.
 */
function descriptionFor(explicit: string | undefined, body: string): string | null {
  if (explicit?.trim()) return explicit.trim()
  const lines = body.trim().split('\n')
  if (lines.length > 1 && lines[0].trim()) return lines[0].trim()
  return null
}

/** `--relates-to` values plus any `[[session-id]]` written inline in the body. */
function linksFor(explicit: string[], body: string): string[] {
  return Array.from(new Set([...explicit, ...parseInlineLinks(body)]))
}

/**
 * Read the index, healing or reporting first.
 *
 * A store whose index is missing is rebuilt in place: the session files are the
 * source of truth and there is nothing in an absent index to lose. A stale index
 * is only reported — rebuilding it silently could drop tags that only exist there.
 */
function loadIndex(vgDir: string): IndexEntry[] {
  const p = vgPaths(vgDir)
  const health = checkIndexHealth(vgDir)

  if (health.state === 'missing') {
    // Healing writes to disk from what is otherwise a read command. A store on a
    // read-only mount, or one owned by another user, must still be readable — so
    // fall back to the in-memory rebuild rather than failing the command.
    try {
      const entries = rebuildIndex(vgDir)
      console.error(`note: index was missing — rebuilt from ${entries.length} session file(s)`)
      if (!fs.existsSync(p.config)) {
        fs.writeFileSync(
          p.config,
          JSON.stringify({ spec_version: SPEC_VERSION, created_at: now() }, null, 2) + '\n',
        )
      }
      return entries
    } catch (err) {
      const entries = buildEntriesFromSessions(vgDir)
      console.error(
        `warning: ${entries.length} session file(s) found but the index is missing and could not be ` +
        `rebuilt (${(err as Error).message}) — reading from the session files directly`,
      )
      return entries
    }
  }

  if (health.state === 'stale') {
    console.error(
      `warning: ${health.sessions} session file(s) on disk but only ${health.indexed} in the index — ` +
      `run \`cogitlog repair\` to see all of them`,
    )
  }

  return readIndex(p.index)
}

async function promptOutcome(): Promise<SessionOutcome> {
  if (!process.stdin.isTTY) {
    console.error('--outcome is required in non-interactive mode')
    process.exit(1)
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question('Outcome [completed/partial/abandoned/interrupted]: ', answer => {
      rl.close()
      const valid: SessionOutcome[] = ['completed', 'partial', 'abandoned', 'interrupted']
      const trimmed = answer.trim() as SessionOutcome
      if (!valid.includes(trimmed)) {
        console.error(`Invalid outcome: ${answer.trim()}`)
        process.exit(1)
      }
      resolve(trimmed)
    })
  })
}

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command()
program
  .name('cogitlog')
  .description('Semantic memory protocol for AI agents working in codebases')
  .version('0.7.0')

// ── init ─────────────────────────────────────────────────────────────────────

// Known agent instruction files, in priority order.
// Each entry is relative to the project root (or absolute if prefixed with /).
const AGENT_INSTRUCTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'WINDSURF.md',
  '.windsurfrules',
  '.cursorrules',
  '.github/copilot-instructions.md',
]

const HINT_BEGIN = '<!-- cogitlog:begin -->'
const HINT_END = '<!-- cogitlog:end -->'

const COGITLOG_HINT = `
${HINT_BEGIN}
## cogitlog

This repository records **why** its changes were made — decisions, the alternatives that
were rejected, and the attempts that failed — in \`.cogitlog/\`.

### Read it before you edit

If a piece of code looks arbitrary, assume it isn't: someone may have already tried the
obvious thing and logged why it failed. Check before rewriting it.

  cogitlog why <file>              # decisions that touched this file
  cogitlog query "<topic>"         # full-text search across every session
  cogitlog log                     # recent sessions, newest first
  cogitlog log -d                  # ...with a one-line description per event
  cogitlog show <session-id>       # one session in full

**Nothing installed?** Either \`npm i -g cogitlog\` and use the commands above, or read the
store directly — \`.cogitlog/sessions/*.jsonl\` is plain JSONL, one event per line, one file
per session, human-readable with no tooling at all.

### Write it as you work

At the start of every task, open a session:

  cogitlog begin "<what you intend to do>"

Record events when they happen:
  - After choosing between alternatives: \`cogitlog decision "<what and why>" -a "rejected:reason"\`
  - After a fix or implementation attempt: \`cogitlog attempt "<what you tried>" [succeeded|failed|partial]\`
  - When you notice something worth remembering: \`cogitlog note "<observation>"\`
  - Before closing, if any choice was borderline: \`cogitlog uncertainty "<the doubt>"\`

A failed attempt is worth more than a successful one — it is what stops the next person
from walking back into the same dead end.

At the end, close the session:

  cogitlog close --outcome <completed|partial|abandoned|interrupted>

Run \`cogitlog onboard\` for full instructions.
${HINT_END}
`

/** Matches a legacy (pre-marker) `## cogitlog` section, up to the next heading or EOF. */
const LEGACY_HINT_RE = /(?:^|\n)#{1,6} cogitlog\b[\s\S]*?(?=\n#{1,6} |\n*$)/

type UpsertResult =
  | 'replaced'   // a managed or legacy block was rewritten
  | 'appended'   // no block existed, one was added
  | 'unchanged'  // the managed block is already current
  | 'skipped'    // the file mentions cogitlog outside any block we manage

/**
 * Put the current hint block into an agent instruction file.
 *
 * Repos initialized by an older version carry an outdated block, so a plain
 * "already mentions cogitlog → skip" check would freeze them on the version that
 * never explained how to *read* the store. Marked blocks and legacy `## cogitlog`
 * sections are therefore replaced in place; a file that mentions cogitlog in some
 * other hand-written way is left alone unless forced.
 */
function upsertCogitlogHint(filePath: string, force = false): UpsertResult {
  const content = fs.readFileSync(filePath, 'utf8')

  const start = content.indexOf(HINT_BEGIN)
  const end = content.indexOf(HINT_END)
  if (start !== -1 && end > start) {
    const updated = content.slice(0, start) + COGITLOG_HINT.trim() + content.slice(end + HINT_END.length)
    if (updated === content) return 'unchanged'
    fs.writeFileSync(filePath, updated, 'utf8')
    return 'replaced'
  }

  if (LEGACY_HINT_RE.test(content)) {
    fs.writeFileSync(filePath, content.replace(LEGACY_HINT_RE, '\n' + COGITLOG_HINT.trim() + '\n'), 'utf8')
    return 'replaced'
  }

  if (content.includes('cogitlog') && !force) return 'skipped'

  fs.appendFileSync(filePath, content.endsWith('\n') ? COGITLOG_HINT : '\n' + COGITLOG_HINT)
  return 'appended'
}

const COGITLOG_ROOT_FILE = `This project uses cogitlog to record why its changes were made —
decisions, rejected alternatives, and failed attempts.

Read the log before changing code that looks arbitrary:

  npm i -g cogitlog
  cogitlog why <file>          # decisions that touched a file
  cogitlog query "<topic>"     # search every session
  cogitlog log                 # recent sessions

Or read it without installing anything: .cogitlog/sessions/*.jsonl is plain
JSONL, one event per line.

Run \`cogitlog onboard\` for the full protocol.
`

/** Write/refresh the hint into every agent instruction file that exists. Returns a per-file result. */
function syncInstructionFiles(projectRoot: string, force = false): Array<[string, UpsertResult]> {
  const results: Array<[string, UpsertResult]> = []
  for (const rel of AGENT_INSTRUCTION_FILES) {
    const filePath = path.join(projectRoot, rel)
    if (!fs.existsSync(filePath)) continue
    results.push([rel, upsertCogitlogHint(filePath, force)])
  }
  return results
}

function reportInstructionSync(results: Array<[string, UpsertResult]>): void {
  for (const [rel, result] of results) {
    if (result === 'replaced') console.log(`  Updated cogitlog block → ${rel}`)
    else if (result === 'appended') console.log(`  Appended cogitlog block → ${rel}`)
    else if (result === 'unchanged') console.log(`  Already up to date → ${rel}`)
    else console.log(`  Skipped ${rel} (mentions cogitlog outside a managed block)`)
  }
}

program
  .command('init')
  .description('Initialize .cogitlog/ in the current directory (safe to re-run: repairs and refreshes)')
  .action(() => {
    const existing = findVibegitDir(process.cwd())
    const vgDir = existing ?? path.join(process.cwd(), '.cogitlog')
    const p = vgPaths(vgDir)

    if (existing) {
      console.log(`.cogitlog/ already exists at ${path.relative(process.cwd(), existing) || '.'}`)
      // An old store may be missing the scaffolding entirely — fill it in rather
      // than leaving the repo answering "No sessions" forever.
      fs.mkdirSync(p.sessions, { recursive: true })
      if (!fs.existsSync(p.config)) {
        fs.writeFileSync(
          p.config,
          JSON.stringify({ spec_version: SPEC_VERSION, created_at: now() }, null, 2) + '\n',
        )
        console.log('  Created missing config.json')
      }
      const health = checkIndexHealth(vgDir)
      if (health.state === 'missing') {
        const entries = rebuildIndex(vgDir)
        console.log(`  Index was missing — rebuilt from ${entries.length} session file(s)`)
      } else if (health.state === 'stale') {
        const entries = rebuildIndex(vgDir)
        console.log(`  Index was incomplete — rebuilt ${entries.length} session(s)`)
      } else if (!fs.existsSync(p.index)) {
        fs.writeFileSync(p.index, '')
      }
    } else {
      fs.mkdirSync(p.sessions, { recursive: true })
      fs.writeFileSync(
        p.config,
        JSON.stringify({ spec_version: SPEC_VERSION, created_at: now() }, null, 2) + '\n',
      )
      fs.writeFileSync(p.index, '')
      fs.writeFileSync(
        path.join(vgDir, 'AGENTS.md'),
        'This repo uses cogitlog to track AI agent sessions.\n' +
        'Run `cogitlog onboard` for usage instructions.\n',
      )
    }

    // Root-level hint file — committed to source control so agents see it immediately
    const projectRoot = getGitRoot() ?? process.cwd()
    const hintFile = path.join(projectRoot, 'COGITLOG')
    if (!fs.existsSync(hintFile)) {
      fs.writeFileSync(hintFile, COGITLOG_ROOT_FILE)
      console.log('Created COGITLOG (commit this file so agents can find it)')
    }

    const results = syncInstructionFiles(projectRoot)
    reportInstructionSync(results)
    const touched = results.filter(([, r]) => r === 'replaced' || r === 'appended').length
    if (touched > 0) console.log(`Updated ${touched} agent instruction file(s)`)

    if (!existing) console.log('Initialized .cogitlog/')
  })

// ── remindme ──────────────────────────────────────────────────────────────────

program
  .command('remindme')
  .description('Write/refresh the cogitlog block in agent instruction files (CLAUDE.md, AGENTS.md, etc.)')
  .option('--force', 'Append even to files that mention cogitlog outside a managed block')
  .action((opts: { force?: boolean }) => {
    const projectRoot = getGitRoot() ?? process.cwd()
    const results = syncInstructionFiles(projectRoot, opts.force)

    if (results.length === 0) {
      // No instruction files found — create CLAUDE.md
      const claudeMd = path.join(projectRoot, 'CLAUDE.md')
      fs.writeFileSync(claudeMd, COGITLOG_HINT.trimStart())
      console.log('  Created CLAUDE.md with the cogitlog block')
      return
    }

    reportInstructionSync(results)
    if (results.some(([, r]) => r === 'skipped')) {
      console.log('  Use --force to append the block to skipped files anyway.')
    }
  })

// ── begin ─────────────────────────────────────────────────────────────────────

program
  .command('begin <intent>')
  .description('Open a new session')
  .option('-c, --context <text>', 'Additional context')
  .option('-r, --resume <session-id>', 'Session this continues (resumed_from)')
  .option('-t, --tag <tag>', 'Tag — repeatable', collect, [] as string[])
  .action(async (intent: string, opts: { context?: string; resume?: string; tag: string[] }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    resolveInterrupted(vgDir)

    const existingId = getCurrentId(p.current)
    if (existingId) {
      const orphanEvents = readEvents(p.session(existingId))
      if (!orphanEvents.some(e => e.type === 'close')) {
        // Auto-close the orphan session instead of blocking
        const orphanFile = p.session(existingId)
        const closeEvent: SessionEvent = {
          session_id: existingId,
          seq: nextSeq(orphanFile),
          type: 'close',
          at: now(),
          outcome: 'interrupted',
          outcome_note: 'auto-closed: new session started',
          files: autoFileRefs(getGitRoot()),
        }
        appendEvent(orphanFile, closeEvent)

        const allOrphanEvents = readEvents(orphanFile)
        const orphanBegin = allOrphanEvents.find(e => e.type === 'begin') as any
        const existingEntries = readIndex(p.index)
        const existingEntry = existingEntries.find(e => e.session_id === existingId)

        const closedEntry: IndexEntry = {
          session_id: existingId,
          index_version: (existingEntry?.index_version ?? 1) + 1,
          started_at: orphanBegin?.at ?? closeEvent.at,
          closed_at: closeEvent.at,
          agent: { tool: AGENT_TOOL, model: null },
          git_head: orphanBegin?.git_head ?? null,
          intent: orphanBegin?.intent ?? '',
          outcome: 'interrupted',
          outcome_note: 'auto-closed: new session started',
          files: deriveFiles(allOrphanEvents),
          tags: existingEntry?.tags ?? [],
          digest: deriveDigest(allOrphanEvents),
          links: deriveLinks(allOrphanEvents),
        }
        await appendIndex(p.index, p.lock, closedEntry)
        await clearCurrentId(p.current, p.lock)

        console.error(`warning: auto-closed orphan session ${existingId} (interrupted)`)
      }
    }

    const sessionId = makeSessionId()
    const gitRoot = getGitRoot()
    const gitHead = getHead(gitRoot ?? undefined)

    const event: SessionEvent = {
      session_id: sessionId,
      seq: 0,
      type: 'begin',
      at: now(),
      intent,
      context: opts.context ?? null,
      git_head: gitHead,
      resumed_from: opts.resume ?? null,
    }
    appendEvent(p.session(sessionId), event)
    await setCurrentId(p.current, p.lock, sessionId)

    const entry: IndexEntry = {
      session_id: sessionId,
      index_version: 1,
      started_at: event.at,
      closed_at: null,
      agent: { tool: AGENT_TOOL, model: null },
      git_head: gitHead,
      intent,
      outcome: 'in_progress',
      outcome_note: null,
      files: [],
      tags: opts.tag,
      digest: [],
      links: opts.resume ? [opts.resume] : [],
    }
    await appendIndex(p.index, p.lock, entry)

    console.log(`Session started: ${sessionId}`)
  })

// ── note ──────────────────────────────────────────────────────────────────────

program
  .command('note <text>')
  .description('Add a note to the current session')
  .option('-f, --file <path>', 'File reference — repeatable (default: auto-detect from git)', collect, [] as string[])
  .option('-d, --description <text>', 'One-line summary (default: first line of the body)')
  .option('--relates-to <session-id>', 'Session this refers to — repeatable', collect, [] as string[])
  .action(async (text: string, opts: { file: string[]; description?: string; relatesTo: string[] }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const sessionId = requireActiveSession(vgDir)

    const event: SessionEvent = {
      session_id: sessionId,
      seq: nextSeq(p.session(sessionId)),
      type: 'note',
      at: now(),
      body: text,
      description: descriptionFor(opts.description, text),
      links: linksFor(opts.relatesTo, text),
      files: fileRefs(opts.file, getGitRoot()),
    }
    appendEvent(p.session(sessionId), event)
    console.log('Note recorded')
  })

// ── decision ──────────────────────────────────────────────────────────────────

program
  .command('decision <text>')
  .description('Record a decision')
  .option('-f, --file <path>', 'File reference — repeatable', collect, [] as string[])
  .option(
    '-a, --alternative <option:reason>',
    'Rejected alternative — format "option:reason", repeatable (colon separates at first occurrence)',
    collect,
    [] as string[],
  )
  .option('-d, --description <text>', 'One-line summary (default: first line of the body)')
  .option('--relates-to <session-id>', 'Session this supersedes or builds on — repeatable', collect, [] as string[])
  .action(async (text: string, opts: { file: string[]; alternative: string[]; description?: string; relatesTo: string[] }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const sessionId = requireActiveSession(vgDir)

    const alternatives = opts.alternative.map(raw => {
      const idx = raw.indexOf(':')
      if (idx === -1) {
        console.error(`--alternative must be in "option:reason" format, got: ${raw}`)
        process.exit(1)
      }
      return { option: raw.slice(0, idx), reason_rejected: raw.slice(idx + 1) }
    })

    const event: SessionEvent = {
      session_id: sessionId,
      seq: nextSeq(p.session(sessionId)),
      type: 'decision',
      at: now(),
      body: text,
      description: descriptionFor(opts.description, text),
      links: linksFor(opts.relatesTo, text),
      alternatives,
      files: fileRefs(opts.file, getGitRoot()),
    }
    appendEvent(p.session(sessionId), event)
    console.log('Decision recorded')
  })

// ── attempt ───────────────────────────────────────────────────────────────────

program
  .command('attempt <text> [outcome]')
  .description('Record an attempt (outcome defaults to "succeeded")')
  .option('--outcome <outcome>', 'succeeded | failed | partial')
  .option('--reason <text>', 'Why it failed or was partial')
  .option('-f, --file <path>', 'File reference — repeatable', collect, [] as string[])
  .option('-d, --description <text>', 'One-line summary (default: first line of the body)')
  .option('--relates-to <session-id>', 'Session this refers to — repeatable', collect, [] as string[])
  .action(async (text: string, positionalOutcome: string | undefined, opts: { outcome?: string; reason?: string; file: string[]; description?: string; relatesTo: string[] }) => {
    const valid: AttemptOutcome[] = ['succeeded', 'failed', 'partial']
    const rawOutcome = opts.outcome ?? positionalOutcome ?? 'succeeded'
    if (!valid.includes(rawOutcome as AttemptOutcome)) {
      console.error(`outcome must be one of: ${valid.join(', ')}`)
      process.exit(1)
    }
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const sessionId = requireActiveSession(vgDir)

    const event: SessionEvent = {
      session_id: sessionId,
      seq: nextSeq(p.session(sessionId)),
      type: 'attempt',
      at: now(),
      body: text,
      description: descriptionFor(opts.description, text),
      links: linksFor(opts.relatesTo, text),
      outcome: rawOutcome as AttemptOutcome,
      reason: opts.reason ?? null,
      files: fileRefs(opts.file, getGitRoot()),
    }
    appendEvent(p.session(sessionId), event)
    console.log('Attempt recorded')
  })

// ── uncertainty ───────────────────────────────────────────────────────────────

program
  .command('uncertainty <text>')
  .description('Flag an uncertainty')
  .option('-f, --file <path>', 'File reference — repeatable', collect, [] as string[])
  .option('-d, --description <text>', 'One-line summary (default: first line of the body)')
  .option('--relates-to <session-id>', 'Session this refers to — repeatable', collect, [] as string[])
  .action(async (text: string, opts: { file: string[]; description?: string; relatesTo: string[] }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const sessionId = requireActiveSession(vgDir)

    const event: SessionEvent = {
      session_id: sessionId,
      seq: nextSeq(p.session(sessionId)),
      type: 'uncertainty',
      at: now(),
      body: text,
      description: descriptionFor(opts.description, text),
      links: linksFor(opts.relatesTo, text),
      files: fileRefs(opts.file, getGitRoot()),
    }
    appendEvent(p.session(sessionId), event)
    console.log('Uncertainty recorded')
  })

// ── close ─────────────────────────────────────────────────────────────────────

program
  .command('close')
  .description('Close the current session')
  .option('--outcome <outcome>', 'completed | partial | abandoned | interrupted')
  .option('--note <text>', 'Outcome note')
  .option('-t, --tag <tag>', 'Tag — repeatable (merged with tags from begin)', collect, [] as string[])
  .action(async (opts: { outcome?: string; note?: string; tag: string[] }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const sessionId = requireActiveSession(vgDir)

    const validOutcomes: SessionOutcome[] = ['completed', 'partial', 'abandoned', 'interrupted']
    let outcome: SessionOutcome
    if (opts.outcome) {
      if (!validOutcomes.includes(opts.outcome as SessionOutcome)) {
        console.error(`--outcome must be one of: ${validOutcomes.join(', ')}`)
        process.exit(1)
      }
      outcome = opts.outcome as SessionOutcome
    } else {
      outcome = await promptOutcome()
    }

    const sessionFile = p.session(sessionId)
    const gitRoot = getGitRoot()

    const event: SessionEvent = {
      session_id: sessionId,
      seq: nextSeq(sessionFile),
      type: 'close',
      at: now(),
      outcome,
      outcome_note: opts.note ?? null,
      files: autoFileRefs(gitRoot), // always snapshot changed files on close
    }
    appendEvent(sessionFile, event)

    const allEvents = readEvents(sessionFile)

    if (!allEvents.some(e => e.type === 'uncertainty')) {
      console.error('hint: no uncertainties were logged this session')
    }

    const begin = allEvents.find(e => e.type === 'begin') as any

    // Merge tags from begin index entry (if any) with tags passed to close
    const existingEntries = readIndex(p.index)
    const existingEntry = existingEntries.find(e => e.session_id === sessionId)
    const mergedTags = Array.from(new Set([...(existingEntry?.tags ?? []), ...opts.tag]))

    const entry: IndexEntry = {
      session_id: sessionId,
      index_version: (existingEntry?.index_version ?? 1) + 1,
      started_at: begin?.at ?? event.at,
      closed_at: event.at,
      agent: { tool: AGENT_TOOL, model: null },
      git_head: begin?.git_head ?? null,
      intent: begin?.intent ?? '',
      outcome,
      outcome_note: opts.note ?? null,
      files: deriveFiles(allEvents),
      tags: mergedTags,
      digest: deriveDigest(allEvents),
      links: deriveLinks(allEvents),
    }
    await appendIndex(p.index, p.lock, entry)
    await clearCurrentId(p.current, p.lock)

    console.log(`Session closed: ${outcome}`)
  })

// ── why ───────────────────────────────────────────────────────────────────────

program
  .command('why <file>')
  .description('Show decisions that reference a file')
  .option('--mentions', 'Show all events, not just decisions')
  .action((file: string, opts: { mentions?: boolean }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const entries = loadIndex(vgDir).filter(e => e.files.includes(file))

    if (entries.length === 0) {
      console.log(`No sessions reference ${file}`)
      console.log(`hint: cogitlog query "${path.basename(file)}" searches the text of every session`)
      return
    }

    for (const entry of entries) {
      const sessionFile = p.session(entry.session_id)
      if (!fs.existsSync(sessionFile)) continue
      const events = readEvents(sessionFile).filter(e => {
        if (!('files' in e) || !e.files.some(f => f.path === file)) return false
        return opts.mentions ? true : e.type === 'decision'
      })
      if (events.length === 0) continue

      console.log(`\n── ${entry.session_id}`)
      console.log(`   intent: ${entry.intent}`)
      for (const e of events) {
        console.log(`   [${e.type}] ${(e as any).body}`)
        if (e.type === 'decision' && e.alternatives.length > 0) {
          for (const alt of e.alternatives) {
            console.log(`     ✗ ${alt.option}: ${alt.reason_rejected}`)
          }
        }
      }
    }
  })

// ── context ───────────────────────────────────────────────────────────────────
//
// Everything ever recorded about a file, newest first. `why` answers "what was
// decided", this answers "what is known" — including the attempts that failed
// and the doubts nobody resolved.
//
// This command was promised by the MCP server and by generated CLAUDE.md blocks
// long before it existed here; calling it returned `unknown command 'context'`.

program
  .command('context <file>')
  .description('Show every event that references a file, newest session first')
  .option('--brief', 'Last 3 sessions only, one line per event')
  .option('-n, --limit <n>', 'Max sessions to show')
  .action((file: string, opts: { brief?: boolean; limit?: string }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)

    const limit = opts.limit ? parseInt(opts.limit, 10) : opts.brief ? 3 : Infinity
    const entries = loadIndex(vgDir)
      .filter(e => e.files.includes(file))
      .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))

    if (entries.length === 0) {
      console.log(`No sessions reference ${file}`)
      console.log(`hint: cogitlog query "${path.basename(file)}" searches the text of every session`)
      return
    }

    const shown = entries.slice(0, limit)
    for (const entry of shown) {
      const sessionFile = p.session(entry.session_id)
      if (!fs.existsSync(sessionFile)) continue
      const events = readEvents(sessionFile).filter(e => {
        if (!('files' in e) || !e.files.some(f => f.path === file)) return false
        // `close` snapshots every changed file, so it matches almost everything.
        // Keep it only when it carries an outcome note worth reading.
        if (e.type === 'close') return Boolean(e.outcome_note)
        return true
      })
      if (events.length === 0) continue

      console.log(`\n── ${entry.started_at.slice(0, 10)}  ${entry.session_id}  (${entry.outcome})`)
      console.log(`   ${entry.intent}`)
      for (const e of events) {
        console.log(`   [${e.type}] ${describeEvent(e)}`)
        if (opts.brief) continue
        if (e.type === 'decision') {
          for (const alt of e.alternatives) console.log(`     ✗ ${alt.option}: ${alt.reason_rejected}`)
        }
        if (e.type === 'attempt' && e.outcome !== 'succeeded') {
          console.log(`     ${e.outcome}${e.reason ? `: ${e.reason}` : ''}`)
        }
      }
    }

    if (entries.length > shown.length) {
      console.log(`\n(${entries.length - shown.length} older session(s) not shown — use -n)`)
    }
  })

// ── show ──────────────────────────────────────────────────────────────────────

program
  .command('show [session-id]')
  .description('Show full details of a session (defaults to current session)')
  .option('--json', 'Output raw JSONL events')
  .action((sessionId: string | undefined, opts: { json?: boolean }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)

    let id = sessionId
    if (!id) {
      resolveInterrupted(vgDir)
      id = getCurrentId(p.current) ?? undefined
      if (!id) {
        console.error('No active session and no session-id given.')
        process.exit(1)
      }
    }

    const sessionFile = p.session(id)
    if (!fs.existsSync(sessionFile)) {
      console.error(`Session not found: ${id}`)
      process.exit(1)
    }

    const events = readEvents(sessionFile)

    if (opts.json) {
      for (const e of events) console.log(JSON.stringify(e))
      return
    }

    const begin = events.find(e => e.type === 'begin') as any
    const close = events.find(e => e.type === 'close') as any
    const entries = readIndex(p.index)
    const entry = entries.find(e => e.session_id === id)
    const links = deriveLinks(events)

    console.log(`Session : ${id}`)
    console.log(`Intent  : ${begin?.intent ?? '(unknown)'}`)
    if (begin?.context) console.log(`Context : ${begin.context}`)
    if (begin?.resumed_from) console.log(`Resumed : ${begin.resumed_from}`)
    console.log(`Outcome : ${close?.outcome ?? entry?.outcome ?? 'in_progress'}`)
    if (close?.outcome_note) console.log(`Note    : ${close.outcome_note}`)
    if (entry?.tags?.length) console.log(`Tags    : ${entry.tags.join(', ')}`)
    if (links.length) console.log(`Links   : ${links.join(', ')}`)
    console.log(`Files   : ${entry?.files?.join(', ') || '(none)'}`)
    console.log('')

    for (const e of events) {
      if (e.type === 'begin' || e.type === 'close') continue
      const ts = e.at.slice(11, 16) // HH:MM
      const body = String((e as any).body ?? '')
      const description = describeEvent(e)
      console.log(`[${ts}] ${e.type.toUpperCase().padEnd(11)} ${description}`)
      // Print only what the description left out: when it came from the body's
      // first line, repeating that line adds nothing.
      const lines = body.trim() ? body.trim().split('\n') : []
      const rest = lines[0]?.trim() === description ? lines.slice(1) : lines
      while (rest.length && !rest[0].trim()) rest.shift()
      for (const line of rest) console.log(`             ${line}`)
      if (((e as any).links ?? []).length > 0) {
        console.log(`             ↔ ${(e as any).links.join(', ')}`)
      }
      if (e.type === 'decision' && e.alternatives.length > 0) {
        for (const alt of e.alternatives) {
          console.log(`             ✗ ${alt.option}: ${alt.reason_rejected}`)
        }
      }
      if (e.type === 'attempt') {
        const reason = e.reason ? ` — ${e.reason}` : ''
        console.log(`             outcome: ${e.outcome}${reason}`)
      }
      if ('files' in e && e.files.length > 0) {
        console.log(`             files: ${e.files.map(f => f.path).join(', ')}`)
      }
    }
  })

// ── query ─────────────────────────────────────────────────────────────────────
//
// Searches everything by default. Until 0.7 the default only looked at `intent`
// and `outcome_note`, so a store holding a full note about X answered
// "No results" for X — a silent lie that reads exactly like an empty store.
// The old behavior is still available as --shallow.
//
// Output contract (--json):
//   One JSON object per line:
//   { session_id, intent, outcome, started_at, source: "index"|"deep", matching_events: Event[] }
//
//   matching_events is [] when source is "index".

/** Every field of an event whose text a search should look at. */
function searchableEventText(e: SessionEvent): string {
  const parts: string[] = [describeEvent(e)]
  if ('body' in e) parts.push(String((e as any).body ?? ''))
  if (e.type === 'decision') {
    for (const alt of e.alternatives) parts.push(alt.option, alt.reason_rejected)
  }
  if (e.type === 'attempt') parts.push(e.outcome, e.reason ?? '')
  if (e.type === 'begin') parts.push(e.intent, e.context ?? '')
  if (e.type === 'close') parts.push(e.outcome, e.outcome_note ?? '')
  for (const l of (e as any).links ?? []) parts.push(l)
  return parts.join('\n').toLowerCase()
}

function searchableIndexText(entry: IndexEntry): string {
  return [
    entry.intent,
    entry.outcome_note ?? '',
    ...entry.tags,
    ...(entry.digest ?? []).map(d => d.description),
  ].join('\n').toLowerCase()
}

program
  .command('query <text>')
  .description('Search every session — intent, descriptions, bodies, alternatives, tags')
  .option('--shallow', 'Only search the index (intent, outcome note, tags, descriptions)')
  .option('--deep', 'Deprecated: deep search is the default since 0.7')
  .option('--json', 'Output as JSONL (one object per match)')
  .action((text: string, opts: { shallow?: boolean; deep?: boolean; json?: boolean }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const needle = text.toLowerCase()
    const entries = loadIndex(vgDir)

    type Match = { entry: IndexEntry; source: 'index' | 'deep'; matchingEvents: SessionEvent[] }
    const results: Match[] = []

    for (const entry of entries) {
      if (searchableIndexText(entry).includes(needle)) {
        results.push({ entry, source: 'index', matchingEvents: [] })
        continue
      }

      if (opts.shallow) continue

      const sessionFile = p.session(entry.session_id)
      if (!fs.existsSync(sessionFile)) continue
      const hits = readEvents(sessionFile).filter(e => searchableEventText(e).includes(needle))
      if (hits.length > 0) {
        results.push({ entry, source: 'deep', matchingEvents: hits })
      }
    }

    if (results.length === 0) {
      if (opts.json) return
      if (entries.length === 0) {
        console.log('No results — this store has no sessions yet.')
      } else if (opts.shallow) {
        console.log(`No results in ${entries.length} session(s). Drop --shallow to search event bodies too.`)
      } else {
        console.log(`No results — searched every event of ${entries.length} session(s).`)
      }
      return
    }

    for (const { entry, source, matchingEvents } of results) {
      if (opts.json) {
        console.log(JSON.stringify({
          session_id: entry.session_id,
          intent: entry.intent,
          outcome: entry.outcome,
          started_at: entry.started_at,
          source,
          matching_events: matchingEvents,
        }))
      } else {
        const tag = source === 'deep' ? `[+${matchingEvents.length}]` : '[index]'
        console.log(`${tag} ${entry.session_id} — ${entry.intent} (${entry.outcome})`)
        for (const e of matchingEvents) {
          console.log(`  [${e.type}] ${describeEvent(e)}`)
        }
      }
    }
  })

// ── log ───────────────────────────────────────────────────────────────────────

program
  .command('log')
  .description('List recent sessions')
  .option('-n, --limit <n>', 'Max sessions to show', '20')
  .option('-d, --descriptions', 'Also print a one-line description per event')
  .action((opts: { limit: string; descriptions?: boolean }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const entries = loadIndex(vgDir)
      .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))
      .slice(0, parseInt(opts.limit, 10))

    if (entries.length === 0) {
      console.log('No sessions')
      return
    }

    for (const e of entries) {
      const date = e.started_at.slice(0, 10)
      const outcome = e.outcome.padEnd(13)
      console.log(`${date}  ${outcome}  ${e.session_id}  ${e.intent}`)

      if (!opts.descriptions) continue
      // Entries written before spec 0.4 have no digest — derive it on the fly
      // rather than showing nothing for the sessions that predate the field.
      const digest = e.digest ?? deriveDigest(readEvents(p.session(e.session_id)))
      for (const d of digest) {
        console.log(`${' '.repeat(28)}· ${d.type.padEnd(11)} ${d.description}`)
      }
      if (e.outcome_note) console.log(`${' '.repeat(28)}→ ${e.outcome_note}`)
    }
  })

// ── status ────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show the current session status')
  .action(() => {
    const vgDir = findVibegitDir()
    if (!vgDir) { console.log('Not a cogitlog repository'); return }

    const p = vgPaths(vgDir)
    resolveInterrupted(vgDir)
    const id = getCurrentId(p.current)

    if (!id) {
      console.log('No active session')
      const entries = loadIndex(vgDir)
      console.log(`Sessions: ${entries.length}`)
      return
    }

    const events = readEvents(p.session(id))
    const begin = events.find(e => e.type === 'begin') as any
    const elapsedMin = begin
      ? Math.floor((Date.now() - new Date(begin.at).getTime()) / 60_000)
      : 0

    console.log(`Session : ${id}`)
    console.log(`Intent  : ${begin?.intent ?? '(unknown)'}`)
    if (begin?.context) console.log(`Context : ${begin.context}`)
    console.log(`Events  : ${events.length}`)
    console.log(`Elapsed : ${elapsedMin}m`)
  })

// ── repair ────────────────────────────────────────────────────────────────────

program
  .command('repair')
  .description('Rebuild index.jsonl from the session files (also backfills descriptions)')
  .action(() => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)

    if (!fs.existsSync(p.sessions)) {
      console.log('No sessions directory — nothing to repair')
      return
    }

    if (!fs.existsSync(p.config)) {
      fs.writeFileSync(
        p.config,
        JSON.stringify({ spec_version: SPEC_VERSION, created_at: now() }, null, 2) + '\n',
      )
      console.log('Created missing config.json')
    }

    const entries = rebuildIndex(vgDir)
    console.log(`Rebuilt index: ${entries.length} session(s)`)
  })

// ── onboard ───────────────────────────────────────────────────────────────────

program
  .command('onboard')
  .description('Print usage instructions for agents unfamiliar with cogitlog')
  .action(() => {
    console.log(`
cogitlog — semantic session memory for AI agents
================================================

This repo records AI agent sessions in .cogitlog/ alongside git history.
Each session captures intent, decisions, attempts, and uncertainties so
future agents (and humans) can understand not just *what* changed but *why*.

READING THE LOG (do this first)
-------------------------------
Before changing code that looks arbitrary, check whether someone already
explained it — or already tried your idea and logged why it failed:

  cogitlog log                    # recent sessions, newest first
  cogitlog log -d                 # ...with one description per event
  cogitlog why <file>             # decisions that touched a file
  cogitlog query "<text>"         # searches everything: descriptions,
                                  # bodies, rejected alternatives, tags
  cogitlog query "<text>" --shallow   # index only — faster, much narrower
  cogitlog show <session-id>      # one session in full

The store does not depend on this CLI. .cogitlog/sessions/*.jsonl is plain
JSONL — one event per line, one file per session. Anyone can read it with
cat, jq, or an editor, with nothing installed.

WRITING THE LOG
---------------
At the start of every task, open a session:

  cogitlog begin "<what you intend to do>" [--context "<extra background>"]

  If a previous session was left open, it is auto-closed as interrupted.

During the task, record events when they happen:

  After choosing between alternatives:
    cogitlog decision "<what you chose and why>" [-a "<option:reason rejected>"]

  After a fix, implementation, or debugging attempt:
    cogitlog attempt "<what you tried>" [succeeded|failed|partial]

  When you notice something worth remembering:
    cogitlog note "<observation or progress update>"

  Before closing, if any choice felt borderline:
    cogitlog uncertainty "<what you don't know or aren't confident about>"

A failed attempt is worth more than a successful one — it is what keeps the
next person from walking back into the same dead end.

Every event takes an optional one-line summary, which is what \`log -d\` and
\`query\` scan. Multi-line bodies use their first line automatically:

    cogitlog note "<long body>" -d "<one-line summary>"

Events can point at other sessions, so a decision can name the one it
supersedes — either \`--relates-to <session-id>\` or [[session-id]] inline.

At the end of the task, close the session:

  cogitlog close --outcome <completed|partial|abandoned|interrupted> [--note "<summary>"]

Use interrupted if you hit a context limit or are stopping mid-task.
A future agent can resume with: cogitlog begin "<intent>" --resume <session-id>

MAINTENANCE
-----------
  cogitlog repair                 # rebuild the index from the session files
                                  # (needed for stores written before 0.7)

CURRENT STATUS
--------------`)

    const vgDir = findVibegitDir()
    if (!vgDir) {
      console.log('  No .cogitlog/ found in this directory tree.\n  Run `cogitlog init` to initialize.\n')
      return
    }
    const p = vgPaths(vgDir)
    resolveInterrupted(vgDir)
    const activeId = getCurrentId(p.current)
    if (activeId) {
      const events = readEvents(p.session(activeId))
      const begin = events.find(e => e.type === 'begin') as any
      console.log(`  Active session : ${activeId}`)
      console.log(`  Intent         : ${begin?.intent ?? '(unknown)'}`)
      console.log(`  Events so far  : ${events.length}`)
    } else {
      const entries = loadIndex(vgDir)
      console.log(`  No active session.`)
      console.log(`  Sessions       : ${entries.length}`)
      if (entries.length > 0) {
        const last = entries.sort((a, b) => (b.started_at > a.started_at ? 1 : -1))[0]
        console.log(`  Last session   : ${last.session_id} — ${last.intent} (${last.outcome})`)
      }
    }
    console.log('')
  })

// ── hook ─────────────────────────────────────────────────────────────────────

const hookCmd = program.command('hook').description('Manage git hooks for cogitlog')

const POST_COMMIT_SCRIPT = [
  '#!/bin/sh',
  '# cogitlog post-commit hook — auto-closes active session on commit',
  'if command -v cogitlog >/dev/null 2>&1; then',
  '  COMMIT=$(git rev-parse HEAD 2>/dev/null)',
  '  SUBJECT=$(git log -1 --format=%s 2>/dev/null)',
  '  cogitlog close --outcome completed --note "Committed: $SUBJECT ($COMMIT)" 2>/dev/null || true',
  'fi',
].join('\n')

hookCmd
  .command('install')
  .description('Install post-commit hook to auto-close sessions on git commit')
  .action(() => {
    const gitRoot = getGitRoot()
    if (!gitRoot) { console.error('Not inside a git repository'); process.exit(1) }

    const hookFile = path.join(gitRoot, '.git', 'hooks', 'post-commit')

    if (fs.existsSync(hookFile)) {
      const existing = fs.readFileSync(hookFile, 'utf8')
      if (existing.includes('cogitlog')) { console.log('Hook already installed'); return }
      fs.appendFileSync(hookFile, '\n' + POST_COMMIT_SCRIPT + '\n')
    } else {
      fs.writeFileSync(hookFile, POST_COMMIT_SCRIPT + '\n', 'utf8')
      fs.chmodSync(hookFile, '755')
    }

    console.log(`Installed post-commit hook: ${hookFile}`)
  })

hookCmd
  .command('uninstall')
  .description('Remove cogitlog lines from post-commit hook')
  .action(() => {
    const gitRoot = getGitRoot()
    if (!gitRoot) { console.error('Not inside a git repository'); process.exit(1) }

    const hookFile = path.join(gitRoot, '.git', 'hooks', 'post-commit')
    if (!fs.existsSync(hookFile)) { console.log('No post-commit hook found'); return }

    const content = fs.readFileSync(hookFile, 'utf8')
    if (!content.includes('cogitlog')) { console.log('No cogitlog hook found'); return }

    const cogitlogLines = new Set(POST_COMMIT_SCRIPT.split('\n'))
    const filtered = content.split('\n').filter(line => !cogitlogLines.has(line)).join('\n')
    fs.writeFileSync(hookFile, filtered, 'utf8')
    console.log('Removed cogitlog hook')
  })

// ─────────────────────────────────────────────────────────────────────────────

program.parse()
