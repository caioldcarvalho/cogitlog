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
import { autoFileRefs, getChangedFiles, getGitRoot, getHead, getStagedFiles, resolveFileRefs } from './git'
import { REFRESH_COMMAND, printUpdateNotice, refreshCache, scheduleUpdateCheck } from './update'
import { withLock } from './lock'
import { configFile, loadConfig, runObserve, saveConfig } from './observe'
import { execFileSync } from 'child_process'
import os from 'os'
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

function normFile(file: string): string {
  return path.normalize(file).replace(/^\.\//, '')
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

// Read, not hardcoded: a literal here drifted from package.json for a whole release.
const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

const program = new Command()
program
  .name('cogitlog')
  .description('Semantic memory protocol for AI agents working in codebases')
  .version(VERSION)

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
  cogitlog context <file>          # everything recorded about this file
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

    if (opts.resume) {
      const resumeFile = p.session(opts.resume)
      if (!fs.existsSync(resumeFile)) {
        console.error(`Session to resume not found: ${opts.resume}`)
        process.exit(1)
      }
    }

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
  .option('--if-open', 'Do nothing, quietly, when no session is open (for hooks)')
  .action(async (opts: { outcome?: string; note?: string; tag: string[]; ifOpen?: boolean }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)

    // Hooks fire on every commit, including the ones made with no session open.
    // Without this they print "No active session" as an error each time, which
    // trains people to ignore everything cogitlog says.
    if (opts.ifOpen) {
      resolveInterrupted(vgDir)
      if (!getCurrentId(p.current)) return
    }
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
    const needle = normFile(file)
    const entries = loadIndex(vgDir).filter(e => e.files.some(f => normFile(f) === needle))

    if (entries.length === 0) {
      console.log(`No sessions reference ${file}`)
      console.log(`hint: cogitlog query "${path.basename(file)}" searches the text of every session`)
      return
    }

    for (const entry of entries) {
      const sessionFile = p.session(entry.session_id)
      if (!fs.existsSync(sessionFile)) continue
      const events = readEvents(sessionFile).filter(e => {
        if (!('files' in e) || !e.files.some(f => normFile(f.path) === needle)) return false
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

// ── context ──────────────────────────────────────────────────────────────────
//
// Everything ever recorded about a file, newest session first. `why` answers
// "what was decided"; this answers "what is known" — including the attempts that
// failed and the doubts nobody resolved.

program
  .command('context <file>')
  .description('Show all events (decisions, attempts, notes, uncertainties) related to a file')
  .option('--brief', 'Concise output — last 3 sessions, one line per event')
  .option('-n, --limit <n>', 'Max sessions to show')
  .action((file: string, opts: { brief?: boolean; limit?: string }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const needle = normFile(file)
    const matching = loadIndex(vgDir)
      .filter(e => e.files.some(f => normFile(f) === needle))
      .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))

    if (matching.length === 0) {
      if (!opts.brief) {
        console.log(`No sessions reference ${file}`)
        console.log(`hint: cogitlog query "${path.basename(file)}" searches the text of every session`)
      }
      return
    }

    const limit = opts.limit ? parseInt(opts.limit, 10) : opts.brief ? 3 : Infinity
    const entries = matching.slice(0, limit)

    let totalEvents = 0
    for (const entry of entries) {
      const sessionFile = p.session(entry.session_id)
      if (!fs.existsSync(sessionFile)) continue
      const events = readEvents(sessionFile).filter(e => {
        if (!('files' in e) || !e.files.some(f => normFile(f.path) === needle)) return false
        // `close` snapshots every changed file, so it matches almost everything.
        // Keep it only when it carries an outcome note worth reading.
        if (e.type === 'close') return Boolean(e.outcome_note)
        return true
      })
      if (events.length === 0) continue

      totalEvents += events.length
      const date = entry.started_at.slice(0, 10)

      if (opts.brief) {
        console.log(`[${date}] ${entry.intent} (${entry.outcome})`)
        for (const e of events) {
          const prefix = e.type === 'decision' ? 'decided' :
                         e.type === 'attempt' ? `tried (${(e as any).outcome})` :
                         e.type === 'uncertainty' ? 'uncertain' :
                         e.type === 'close' ? 'closed' : 'note'
          console.log(`  ${prefix}: ${describeEvent(e)}`)
        }
      } else {
        console.log(`\n── ${date} ${entry.session_id}`)
        console.log(`   intent: ${entry.intent} (${entry.outcome})`)

        for (const e of events) {
          const ts = e.at.slice(11, 16)
          console.log(`   [${ts}] ${e.type.toUpperCase().padEnd(11)} ${describeEvent(e)}`)
          if (e.type === 'decision' && e.alternatives.length > 0) {
            for (const alt of e.alternatives) {
              console.log(`            ✗ ${alt.option}: ${alt.reason_rejected}`)
            }
          }
          if (e.type === 'attempt') {
            const reason = e.reason ? ` — ${e.reason}` : ''
            console.log(`            outcome: ${e.outcome}${reason}`)
          }
        }
      }
    }

    if (totalEvents === 0) {
      if (!opts.brief) console.log(`No events reference ${file}`)
    } else if (matching.length > entries.length) {
      console.log(`\n(${matching.length - entries.length} older session(s) not shown — use -n)`)
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
  .option('--deep', 'Deprecated: deep search is the default since 0.8')
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
  cogitlog context <file>         # everything recorded about a file
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
                                  # (needed for stores written before 0.8)

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

// ── guard ─────────────────────────────────────────────────────────────────────
//
// The reminder the pre-commit hook prints. It never fails a commit: not every
// commit deserves a session — a lockfile bump, a typo fix, a formatting pass — and
// a hook that blocks on those only teaches people to reach for --no-verify, which
// kills the reminder entirely.
//
// What it can do is make the cheap path cheap: instead of "you forgot to log
// something", it prints the command already filled in with this commit's files.
// Copying a line is easier than ignoring it.

/** Files staged for commit, falling back to everything changed in the tree. */
function commitFiles(gitRoot: string | null): string[] {
  const staged = getStagedFiles(gitRoot ?? undefined)
  const files = staged.length > 0 ? staged : getChangedFiles(gitRoot ?? undefined)
  return files.filter(f => !f.startsWith('.cogitlog/'))
}

const GUARD_FILE_LIMIT = 6

function fileFlags(files: string[]): string {
  const shown = files.slice(0, GUARD_FILE_LIMIT)
  const flags = shown.map(f => `-f ${f}`).join(' ')
  return files.length > shown.length ? `${flags} …` : flags
}

program
  .command('guard')
  .description('Warn when a commit carries no recorded reasoning (never fails — see --strict)')
  .option('--strict', 'Exit 1 instead of 0, for anyone who wants a blocking hook')
  .option('--quiet', 'Say nothing when there is nothing to warn about')
  .action((opts: { strict?: boolean; quiet?: boolean }) => {
    if (process.env.COGITLOG_SKIP) return

    const vgDir = findVibegitDir()
    // A repo that does not use cogitlog is not doing anything wrong.
    if (!vgDir) return

    const p = vgPaths(vgDir)
    resolveInterrupted(vgDir)
    const sessionId = getCurrentId(p.current)
    const gitRoot = getGitRoot()
    const files = commitFiles(gitRoot)

    const events = sessionId ? readEvents(p.session(sessionId)) : []
    const recorded = events.filter(e => e.type !== 'begin' && e.type !== 'close')

    if (sessionId && recorded.length > 0) {
      if (!opts.quiet) {
        console.error(`cogitlog: ${recorded.length} event(s) recorded in this session.`)
      }
      return
    }

    const subject = files.length === 0 ? 'this commit'
      : files.length === 1 ? files[0]
      : `${files.length} files`
    const flags = files.length > 0 ? ` ${fileFlags(files)}` : ''

    console.error('')
    if (!sessionId) {
      console.error(`cogitlog: nothing recorded for ${subject}. To leave a trace:`)
      console.error(`  cogitlog begin "<what you set out to do>"`)
      console.error(`  cogitlog decision "<what you chose and why>"${flags}`)
    } else {
      console.error(`cogitlog: session open for ${subject} but no events recorded. To leave a trace:`)
      console.error(`  cogitlog decision "<what you chose and why>"${flags}`)
    }
    console.error(`  (nothing worth recording? ignore this, or set COGITLOG_SKIP=1)`)
    console.error('')

    if (opts.strict) process.exit(1)
  })

// ── hook ─────────────────────────────────────────────────────────────────────

const hookCmd = program.command('hook').description('Manage git hooks for cogitlog')

const POST_COMMIT_SCRIPT = [
  '#!/bin/sh',
  '# cogitlog post-commit hook — auto-closes active session on commit',
  'if command -v cogitlog >/dev/null 2>&1; then',
  '  COMMIT=$(git rev-parse HEAD 2>/dev/null)',
  '  SUBJECT=$(git log -1 --format=%s 2>/dev/null)',
  '  cogitlog close --if-open --outcome completed --note "Committed: $SUBJECT ($COMMIT)" || true',
  'fi',
].join('\n')

/** Earlier wordings of the hooks, so `uninstall` can still recognise them. */
const LEGACY_HOOK_LINES = [
  '  cogitlog close --outcome completed --note "Committed: $SUBJECT ($COMMIT)" || true',
  '  cogitlog close --outcome completed --note "Committed: $SUBJECT ($COMMIT)" 2>/dev/null || true',
]

// Both guards exist because a hook is per-clone, not per-repo: .git/hooks is not
// versioned, so nobody gets this by cloning. And `command -v` means a teammate
// without cogitlog installed is never affected by a hook they somehow inherited.
// The trailing `exit 0` makes it structurally impossible to fail a commit.
const PRE_COMMIT_SCRIPT = [
  '#!/bin/sh',
  '# cogitlog pre-commit hook — reminds, never blocks',
  'if [ -z "$COGITLOG_SKIP" ] && command -v cogitlog >/dev/null 2>&1; then',
  '  cogitlog guard --quiet || true',
  'fi',
  'exit 0',
].join('\n')

function installHookScript(gitRoot: string, name: string, script: string): 'installed' | 'present' {
  const hookFile = path.join(gitRoot, '.git', 'hooks', name)

  if (fs.existsSync(hookFile)) {
    const existing = fs.readFileSync(hookFile, 'utf8')
    if (existing.includes('cogitlog')) return 'present'
    fs.appendFileSync(hookFile, '\n' + script + '\n')
  } else {
    fs.writeFileSync(hookFile, script + '\n', 'utf8')
    fs.chmodSync(hookFile, '755')
  }
  return 'installed'
}

function removeHookScript(gitRoot: string, name: string, script: string): boolean {
  const hookFile = path.join(gitRoot, '.git', 'hooks', name)
  if (!fs.existsSync(hookFile)) return false

  const content = fs.readFileSync(hookFile, 'utf8')
  if (!content.includes('cogitlog')) return false

  const cogitlogLines = new Set([...script.split('\n'), ...LEGACY_HOOK_LINES])
  const filtered = content.split('\n').filter(line => !cogitlogLines.has(line)).join('\n')
  // A file left holding only a shebang is a hook that does nothing — drop it.
  if (filtered.replace(/#!.*|\s|exit 0/g, '') === '') fs.unlinkSync(hookFile)
  else fs.writeFileSync(hookFile, filtered, 'utf8')
  return true
}

hookCmd
  .command('install')
  .description('Install post-commit hook to auto-close sessions on git commit')
  .option('--remind', 'Also install a pre-commit hook that warns when a commit has no recorded reasoning')
  .option('--global', 'Install the observer in the global core.hooksPath instead: every commit in a repo you own gets its reasoning recorded, with no per-repo setup')
  .action((opts: { remind?: boolean; global?: boolean }) => {
    if (opts.global) { installGlobalHook(); return }
    const gitRoot = getGitRoot()
    if (!gitRoot) { console.error('Not inside a git repository'); process.exit(1) }

    // With core.hooksPath set, git never looks at .git/hooks: writing there would
    // "succeed" and do nothing at all.
    const hooksPath = gitConfigGet('core.hooksPath')
    if (hooksPath) {
      console.error(`warning: core.hooksPath is set (${hooksPath}), so git ignores .git/hooks.`)
      console.error('  The hooks below will not run unless that directory forwards to them.')
      console.error('  To record reasoning on every commit instead: cogitlog hook install --global')
    }

    const post = installHookScript(gitRoot, 'post-commit', POST_COMMIT_SCRIPT)
    console.log(post === 'present'
      ? 'post-commit hook already installed'
      : `Installed post-commit hook: ${path.join(gitRoot, '.git/hooks/post-commit')}`)

    if (opts.remind) {
      const pre = installHookScript(gitRoot, 'pre-commit', PRE_COMMIT_SCRIPT)
      console.log(pre === 'present'
        ? 'pre-commit hook already installed'
        : `Installed pre-commit hook: ${path.join(gitRoot, '.git/hooks/pre-commit')}`)
      console.log('  It only prints a reminder — it never fails a commit.')
    }
  })

hookCmd
  .command('uninstall')
  .description('Remove cogitlog lines from the post-commit and pre-commit hooks')
  .action(() => {
    const gitRoot = getGitRoot()
    if (!gitRoot) { console.error('Not inside a git repository'); process.exit(1) }

    const removed: string[] = []
    if (removeHookScript(gitRoot, 'post-commit', POST_COMMIT_SCRIPT)) removed.push('post-commit')
    if (removeHookScript(gitRoot, 'pre-commit', PRE_COMMIT_SCRIPT)) removed.push('pre-commit')

    console.log(removed.length > 0
      ? `Removed cogitlog hook(s): ${removed.join(', ')}`
      : 'No cogitlog hooks found')
  })

function gitConfigGet(key: string): string {
  try {
    return execFileSync('git', ['config', '--get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const GLOBAL_MARK = '# cogitlog global post-commit'

// Chains the repo's own post-commit (git skips .git/hooks once core.hooksPath is
// set, so without this every husky-style hook would go silent), keeps its exit
// status, and runs the observer detached so a commit never waits on a model.
const GLOBAL_POST_COMMIT = `#!/bin/sh
${GLOBAL_MARK} — records the reasoning behind each commit (cogitlog observe)
set -u
COMMON=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
status=0
if [ -x "$COMMON/hooks/post-commit" ]; then
  "$COMMON/hooks/post-commit" "$@"
  status=$?
fi
if [ -z "\${COGITLOG_SKIP:-}" ] && [ -z "\${COGITLOG_OBSERVING:-}" ] && command -v cogitlog >/dev/null 2>&1; then
  C=$(git rev-parse HEAD 2>/dev/null)
  ( cogitlog observe --auto --commit "$C" </dev/null >/dev/null 2>&1 & )
fi
exit $status
`

function installGlobalHook(): void {
  let dir = gitConfigGet('core.hooksPath')
  if (!dir) {
    dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'git', 'hooks')
    execFileSync('git', ['config', '--global', 'core.hooksPath', dir])
    console.log(`Set global core.hooksPath to ${dir}`)
  }
  dir = dir.replace(/^~(?=\/|$)/, os.homedir())
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'post-commit')
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(GLOBAL_MARK)) {
    console.error(`${file} already exists and is not cogitlog's. Not touching it.`)
    console.error('Add this line to it to enable the observer:')
    console.error('  ( cogitlog observe --auto --commit "$(git rev-parse HEAD)" </dev/null >/dev/null 2>&1 & )')
    process.exit(1)
  }
  fs.writeFileSync(file, GLOBAL_POST_COMMIT)
  fs.chmodSync(file, 0o755)
  console.log(`Installed observer hook: ${file}`)
  const cfg = loadConfig()
  if (cfg.owners.length === 0) {
    console.log('No owners configured yet: only repos without a remote will be observed.')
    console.log('  cogitlog config owner add <github-user-or-org>')
  } else {
    console.log(`Observing repos owned by: ${cfg.owners.join(', ')} (and repos with no remote)`)
  }
}

// ── observe ───────────────────────────────────────────────────────────────────

program
  .command('observe')
  .description("Record a commit's reasoning from the Claude Code transcript that produced it")
  .option('--commit <sha>', 'Commit to observe (default: HEAD)')
  .option('--auto', 'Hook mode: skip repos you do not own, merges and rebases; log instead of printing')
  .option('--dry-run', 'Show what would be recorded, write nothing')
  .option('--model <model>', 'Model for the extraction (default: config model, else haiku)')
  .action(async (opts: { commit?: string; auto?: boolean; dryRun?: boolean; model?: string }) => {
    const repoRoot = getGitRoot()
    if (!repoRoot) { if (!opts.auto) console.error('Not inside a git repository'); process.exit(opts.auto ? 0 : 1) }

    const logFile = path.join(repoRoot, '.cogitlog', 'observe.log')
    const log = (msg: string) => {
      if (!opts.auto) { console.error(msg); return }
      try {
        if (!fs.existsSync(path.dirname(logFile))) return
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`)
      } catch { /* logging must never fail the hook */ }
    }

    try {
      const r = await runObserve({ repoRoot, commit: opts.commit, auto: opts.auto, dryRun: opts.dryRun, model: opts.model, log })
      if (r.status === 'skipped' && opts.auto) return
      if (r.status === 'written' || r.status === 'dry-run') {
        if (!opts.auto) {
          console.log(r.status === 'written' ? `Recorded session ${r.sessionId}:` : 'Would record:')
          for (const e of r.events ?? []) {
            const tag = e.type === 'attempt' ? `attempt (${e.outcome})` : e.type
            console.log(`  ${tag}: ${e.description || e.body}`)
          }
        }
      } else {
        log(`${r.status}: ${r.reason}`)
      }
    } catch (err: any) {
      log(`observe failed: ${err?.message ?? err}`)
      if (!opts.auto) process.exit(1)
    }
  })

// ── config ────────────────────────────────────────────────────────────────────

const configCmd = program.command('config').description('Machine-wide observer settings (~/.config/cogitlog/config.json)')

configCmd
  .command('show')
  .action(() => {
    console.log(configFile())
    console.log(JSON.stringify(loadConfig(), null, 2))
  })

configCmd
  .command('owner <action> [name]')
  .description('add | remove | list — GitHub users/orgs whose repos the observer records')
  .action((action: string, name?: string) => {
    const cfg = loadConfig()
    if (action === 'list') { console.log(cfg.owners.join('\n') || '(none)'); return }
    if (!name) { console.error('Usage: cogitlog config owner add|remove <name>'); process.exit(1) }
    if (action === 'add') cfg.owners = Array.from(new Set([...cfg.owners, name]))
    else if (action === 'remove') cfg.owners = cfg.owners.filter(o => o !== name)
    else { console.error('action must be add, remove or list'); process.exit(1) }
    saveConfig(cfg)
    console.log(`owners: ${cfg.owners.join(', ') || '(none)'}`)
  })

configCmd
  .command('model <model>')
  .description('Model the observer uses (default haiku)')
  .action((model: string) => {
    const cfg = loadConfig()
    cfg.model = model
    saveConfig(cfg)
    console.log(`model: ${model}`)
  })

// ── agent hooks (Claude Code integration) ────────────────────────────────────

function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) { resolve(''); return }
    let data = ''
    let resolved = false
    const done = (val: string) => { if (!resolved) { resolved = true; resolve(val) } }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
      if (data.length > 1_000_000) done(data) // 1MB safety cap
    })
    process.stdin.on('end', () => done(data))
    setTimeout(() => done(data), timeoutMs)
  })
}

hookCmd
  .command('agent-init')
  .description('SessionStart handler — outputs status + recent sessions for agent context')
  .action(() => {
    const vgDir = findVibegitDir()
    if (!vgDir) return // silently skip if no cogitlog

    const p = vgPaths(vgDir)
    resolveInterrupted(vgDir)

    const entries = readIndex(p.index)
      .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))
      .slice(0, 5)

    if (entries.length === 0) return

    console.log('[cogitlog] Recent agent sessions:')
    for (const e of entries) {
      const date = e.started_at.slice(0, 10)
      console.log(`  ${date}  ${e.outcome.padEnd(13)}  ${e.intent}`)
    }

    const activeId = getCurrentId(p.current)
    if (activeId) {
      const events = readEvents(p.session(activeId))
      const begin = events.find(e => e.type === 'begin') as any
      console.log(`[cogitlog] Active session: ${begin?.intent ?? activeId}`)
    }
  })

hookCmd
  .command('agent-pre-tool')
  .description('PreToolUse handler — injects file context when agent reads/edits a file')
  .action(async () => {
    const vgDir = findVibegitDir()
    if (!vgDir) return

    const raw = await readStdin()
    if (!raw) return

    let input: any
    try { input = JSON.parse(raw) } catch { return }

    const filePath = input?.tool_input?.file_path
    if (!filePath) return

    const p = vgPaths(vgDir)
    // Claude Code passes absolute paths; the store keeps them relative to the repo
    // root. Comparing the two as-is matched nothing, ever.
    const repoRoot = path.dirname(vgDir)
    const needle = normFile(path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath)
    if (needle.startsWith('..')) return
    const entries = readIndex(p.index)
      .filter(e => e.files.some(f => normFile(f) === needle))
      .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))
      .slice(0, 3)

    if (entries.length === 0) return

    const lines: string[] = [`[cogitlog] Past reasoning for ${path.basename(filePath)}:`]
    for (const entry of entries) {
      const sessionFile = p.session(entry.session_id)
      if (!fs.existsSync(sessionFile)) continue
      const events = readEvents(sessionFile).filter(e =>
        'files' in e && e.files.some(f => normFile(f.path) === needle),
      )
      if (events.length === 0) continue

      const date = entry.started_at.slice(0, 10)
      lines.push(`  [${date}] ${entry.intent} (${entry.outcome})`)
      for (const e of events) {
        const body = (e as any).body ?? ''
        const prefix = e.type === 'decision' ? 'decided' :
                       e.type === 'attempt' ? `tried (${(e as any).outcome})` :
                       e.type === 'uncertainty' ? 'uncertain' : 'note'
        lines.push(`    ${prefix}: ${body}`)
      }
    }

    if (lines.length > 1) {
      // PreToolUse stdout is not shown to the model unless it is wrapped like this.
      console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') },
      }))
    }
  })

hookCmd
  .command('agent-begin')
  .description('UserPromptSubmit handler — auto-begins a session from the first user prompt')
  .action(async () => {
    const vgDir = findVibegitDir()
    if (!vgDir) return

    const p = vgPaths(vgDir)

    // Read stdin before acquiring lock (I/O can be slow)
    const raw = await readStdin()
    if (!raw) return

    let input: any
    try { input = JSON.parse(raw) } catch { return }

    // Claude Code sends the text as `prompt`. Older builds of this hook read
    // `message`/`content`, which never exist, so every session became "Auto-session".
    const userMessage = input?.prompt ?? input?.message ?? input?.content ?? ''
    const intent = typeof userMessage === 'string' && userMessage.length > 0
      ? userMessage.slice(0, 120)
      : 'Auto-session'

    // Atomic check-and-create under lock to prevent race conditions
    await withLock(p.lock, async () => {
      resolveInterrupted(vgDir)
      const activeId = getCurrentId(p.current)
      if (activeId) return

      const sessionId = makeSessionId()
      const gitRoot = getGitRoot()
      const gitHead = getHead(gitRoot ?? undefined)

      const event: SessionEvent = {
        session_id: sessionId,
        seq: 0,
        type: 'begin',
        at: now(),
        intent,
        context: 'Auto-started by agent hook',
        git_head: gitHead,
        resumed_from: null,
      }
      appendEvent(p.session(sessionId), event)

      // setCurrentId/appendIndex acquire their own lock, but we already hold it.
      // Write directly to avoid deadlock.
      fs.writeFileSync(p.current, sessionId)
      fs.appendFileSync(p.index, JSON.stringify({
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
        tags: ['auto'],
      } satisfies IndexEntry) + '\n')

      console.log(`[cogitlog] Session started: ${intent.slice(0, 80)}`)
    })
  })

hookCmd
  .command('install-agent')
  .description('Install Claude Code hooks for automatic cogitlog integration')
  .action(() => {
    const projectRoot = getGitRoot() ?? process.cwd()
    const claudeDir = path.join(projectRoot, '.claude')
    const settingsFile = path.join(claudeDir, 'settings.json')

    let settings: any = {}
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      } catch {
        console.error(`Error: ${settingsFile} contains invalid JSON. Fix it manually before running install-agent.`)
        process.exit(1)
      }
    } else {
      fs.mkdirSync(claudeDir, { recursive: true })
    }

    if (!settings.hooks) settings.hooks = {}

    // SessionStart — show recent sessions
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = []
    const hasInit = settings.hooks.SessionStart.some((r: any) =>
      r.hooks?.some((h: any) => h.command?.includes('cogitlog hook agent-init')))
    if (!hasInit) {
      settings.hooks.SessionStart.push({
        matcher: '',
        hooks: [{ type: 'command', command: 'cogitlog hook agent-init || true' }],
      })
      console.log('  Added SessionStart hook (recent sessions)')
    }

    // PreToolUse — inject file context on Read/Edit
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = []
    const hasPreTool = settings.hooks.PreToolUse.some((r: any) =>
      r.hooks?.some((h: any) => h.command?.includes('cogitlog hook agent-pre-tool')))
    if (!hasPreTool) {
      settings.hooks.PreToolUse.push({
        matcher: 'Read|Edit',
        hooks: [{ type: 'command', command: 'cogitlog hook agent-pre-tool || true' }],
      })
      console.log('  Added PreToolUse hook (file context on Read/Edit)')
    }

    // UserPromptSubmit — auto-begin session
    if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = []
    const hasBegin = settings.hooks.UserPromptSubmit.some((r: any) =>
      r.hooks?.some((h: any) => h.command?.includes('cogitlog hook agent-begin')))
    if (!hasBegin) {
      settings.hooks.UserPromptSubmit.push({
        matcher: '',
        hooks: [{ type: 'command', command: 'cogitlog hook agent-begin || true' }],
      })
      console.log('  Added UserPromptSubmit hook (auto-begin session)')
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
    console.log(`\nHooks written to ${path.relative(process.cwd(), settingsFile)}`)
    console.log('Commit .claude/settings.json to share with your team.')
  })

hookCmd
  .command('uninstall-agent')
  .description('Remove Claude Code hooks for cogitlog')
  .action(() => {
    const projectRoot = getGitRoot() ?? process.cwd()
    const settingsFile = path.join(projectRoot, '.claude', 'settings.json')

    if (!fs.existsSync(settingsFile)) {
      console.log('No .claude/settings.json found')
      return
    }

    let settings: any
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { return }

    if (!settings.hooks) { console.log('No hooks found'); return }

    let removed = 0
    for (const event of Object.keys(settings.hooks)) {
      const rules = settings.hooks[event]
      if (!Array.isArray(rules)) continue
      const filtered = rules.filter((r: any) =>
        !r.hooks?.some((h: any) => h.command?.includes('cogitlog hook agent-')))
      removed += rules.length - filtered.length
      if (filtered.length === 0) {
        delete settings.hooks[event]
      } else {
        settings.hooks[event] = filtered
      }
    }

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
    console.log(`Removed ${removed} cogitlog hook(s)`)
  })

// ── install-skills ───────────────────────────────────────────────────────────

const SKILL_READ = `---
description: Check why a file or topic is the way it is before changing it — past decisions, failed attempts and rejected alternatives recorded in .cogitlog/. Usage: /cogitlog-read <file-or-topic> (e.g. /cogitlog-read src/cli.ts, /cogitlog-read "auth flow")
---

## User Input

\`\`\`text
$ARGUMENTS
\`\`\`

If it contains \`/\` or a file extension, treat it as a **file**; otherwise as a **topic**.

## File

Run both:

    cogitlog why <file>               # decisions that touched it
    cogitlog context <file> --brief   # every event about it, last 3 sessions

## Topic

    cogitlog query "<topic>"          # searches descriptions, bodies, rejected alternatives

## Output

Summarize, most useful first:

- **Failed attempts** on this file/topic — what was tried, why it failed. These stop
  you from walking back into a dead end; lead with them.
- **Decisions** and the alternatives they rejected.
- **Open uncertainties.**

Events tagged \`observed\` were extracted from an agent transcript at commit time and
carry an \`evidence\` quote; treat them as reliable but secondhand.

If nothing turns up, say so in one line: "No cogitlog history for {target}."
No CLI installed? Read \`.cogitlog/sessions/*.jsonl\` directly — it is plain JSONL.

This skill is read-only: it opens no session and records nothing.
`

const SKILL_WRITE = `---
description: Record a decision, failed attempt or open doubt in cogitlog by hand, when it is too subtle to trust to the commit-time observer. Usage: /cogitlog-write <what to record>
---

## User Input

\`\`\`text
$ARGUMENTS
\`\`\`

If \`cogitlog hook install --global\` is set up, the observer already extracts the
reasoning of each commit from the agent transcript — routine decisions need nothing
from you. Write by hand only what the observer would miss or blur: a subtle trade-off,
a constraint that came from outside the conversation, a doubt you want the next
person to see.

## How

    cogitlog status                                   # is a session open?
    cogitlog begin "<intent>"                         # only if none is
    cogitlog decision "<what and why>" -a "<rejected option>:<why not>" -f <file>
    cogitlog attempt "<what you tried>" failed --reason "<why it failed>" -f <file>
    cogitlog uncertainty "<the doubt>"
    cogitlog note "<non-obvious fact>"

Leave the session open: the next commit closes it, and a session recorded by hand
during a commit's window makes the observer stand down for that commit.

A failed attempt is worth more than a successful one — it is what stops the next
person from walking back into the same dead end.
`

program
  .command('install-skills')
  .description('Install Claude Code slash-command skills (/cogitlog-read, /cogitlog-write) to ~/.claude/commands/')
  .option('--force', 'Overwrite existing skill files')
  .option('--dir <path>', 'Custom output directory (default: ~/.claude/commands)')
  .action((opts: { force?: boolean; dir?: string }) => {
    const targetDir = opts.dir ?? path.join(process.env.HOME ?? '~', '.claude', 'commands')

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    const skills: { name: string; content: string }[] = [
      { name: 'cogitlog-read.md', content: SKILL_READ },
      { name: 'cogitlog-write.md', content: SKILL_WRITE },
    ]

    let installed = 0
    let skipped = 0

    for (const skill of skills) {
      const filePath = path.join(targetDir, skill.name)
      if (fs.existsSync(filePath) && !opts.force) {
        console.log(`  Skipped ${skill.name} (already exists, use --force to overwrite)`)
        skipped++
        continue
      }
      fs.writeFileSync(filePath, skill.content)
      console.log(`  Installed ${skill.name}`)
      installed++
    }

    console.log(`\n${installed} skill(s) installed to ${targetDir}`)
    if (skipped > 0) console.log(`${skipped} skill(s) skipped (use --force to overwrite)`)
    console.log('\nUsage:')
    console.log('  /cogitlog-read <file-or-topic>   Check history before working')
    console.log('  /cogitlog-write <intent>          Open a session for current task')
  })

// ─────────────────────────────────────────────────────────────────────────────

// The refresh runs in a detached child, so this costs the current command nothing
// but a fork, once a day. The notice itself waits for exit so it lands after the
// output rather than on top of it.
const refreshCmd = new Command(REFRESH_COMMAND)
  .description('internal: refresh the cached latest-version check')
  .action(async () => { await refreshCache() })
program.addCommand(refreshCmd, { hidden: true })

scheduleUpdateCheck()
process.on('exit', () => printUpdateNotice(VERSION))

program.parse()
