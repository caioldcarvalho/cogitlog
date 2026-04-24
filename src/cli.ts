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
  clearCurrentId,
  deriveFiles,
  getCurrentId,
  nextSeq,
  readEvents,
  readIndex,
  resolveInterrupted,
  setCurrentId,
  writeIndex,
} from './io'
import { autoFileRefs, getGitRoot, getHead, resolveFileRefs } from './git'
import { withLock } from './lock'
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
  .version('0.1.0')

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

const COGITLOG_HINT = `
## cogitlog

This project uses [cogitlog](https://github.com/caiocarvalho/cogitlog) to log AI agent sessions.

Before investigating a bug or understanding a past decision, check the log:
  cogitlog why <file>             # why was this file changed?
  cogitlog context <file>         # all reasoning related to a file
  cogitlog query "<text>"         # search sessions by topic
  cogitlog query "<text>" --deep  # also search event bodies

At the start of every task, open a session:
  cogitlog begin "<what you intend to do>"

Record meaningful events during the task:
  cogitlog note / decision / attempt / uncertainty

At the end, close the session:
  cogitlog close --outcome <completed|partial|abandoned|interrupted>

Run \`cogitlog onboard\` for full instructions.
`

function replaceCogitlogSection(content: string): string {
  const sectionRe = /\n?## cogitlog\n[\s\S]*?(?=\n## |\n# |$)/
  return content.replace(sectionRe, '') + COGITLOG_HINT
}

function appendCogitlogHint(filePath: string, force = false): 'appended' | 'replaced' | 'skipped' {
  const content = fs.readFileSync(filePath, 'utf8')
  const hasSection = content.includes('## cogitlog')

  if (hasSection && !force) return 'skipped'

  if (hasSection && force) {
    fs.writeFileSync(filePath, replaceCogitlogSection(content))
    return 'replaced'
  }

  fs.appendFileSync(filePath, COGITLOG_HINT)
  return 'appended'
}

program
  .command('init')
  .description('Initialize .cogitlog/ in the current directory')
  .action(() => {
    const vgDir = path.join(process.cwd(), '.cogitlog')
    if (fs.existsSync(vgDir)) {
      console.log('.cogitlog/ already exists')
      return
    }
    fs.mkdirSync(path.join(vgDir, 'sessions'), { recursive: true })
    fs.writeFileSync(
      path.join(vgDir, 'config.json'),
      JSON.stringify({ spec_version: SPEC_VERSION, created_at: now() }, null, 2) + '\n',
    )
    fs.writeFileSync(path.join(vgDir, 'index.jsonl'), '')
    fs.writeFileSync(
      path.join(vgDir, 'AGENTS.md'),
      'This repo uses cogitlog to track AI agent sessions.\n' +
      'Run `cogitlog onboard` for usage instructions.\n',
    )

    // Root-level hint file — committed to source control so agents see it immediately
    const projectRoot = getGitRoot() ?? process.cwd()
    const hintFile = path.join(projectRoot, 'COGITLOG')
    if (!fs.existsSync(hintFile)) {
      fs.writeFileSync(
        hintFile,
        'This project uses cogitlog to log AI agent sessions.\n' +
        'Run `cogitlog onboard` to see what that means and how to use it.\n',
      )
      console.log('Created COGITLOG (commit this file so agents can find it)')
    }

    // Append cogitlog hint to any existing agent instruction files
    const found: string[] = []
    for (const rel of AGENT_INSTRUCTION_FILES) {
      const filePath = path.join(projectRoot, rel)
      if (fs.existsSync(filePath)) {
        const result = appendCogitlogHint(filePath)
        if (result !== 'skipped') found.push(rel)
      }
    }
    if (found.length > 0) {
      console.log(`Updated ${found.length} agent instruction file(s) with cogitlog reminder`)
    }

    console.log('Initialized .cogitlog/')
  })

// ── remindme ──────────────────────────────────────────────────────────────────

program
  .command('remindme')
  .description('Append cogitlog usage reminder to agent instruction files (CLAUDE.md, AGENTS.md, etc.)')
  .option('--force', 'Replace existing cogitlog section with the latest version')
  .action((opts: { force?: boolean }) => {
    const projectRoot = getGitRoot() ?? process.cwd()
    const found: string[] = []
    const replaced: string[] = []
    const skipped: string[] = []

    for (const rel of AGENT_INSTRUCTION_FILES) {
      const filePath = path.join(projectRoot, rel)
      if (!fs.existsSync(filePath)) continue
      const result = appendCogitlogHint(filePath, opts.force)
      if (result === 'appended') {
        found.push(rel)
        console.log(`  Appended reminder → ${rel}`)
      } else if (result === 'replaced') {
        replaced.push(rel)
        console.log(`  Replaced reminder → ${rel}`)
      } else {
        skipped.push(rel)
      }
    }

    if (found.length === 0 && replaced.length === 0 && skipped.length === 0) {
      // No instruction files found — create CLAUDE.md
      const claudeMd = path.join(projectRoot, 'CLAUDE.md')
      fs.writeFileSync(claudeMd, COGITLOG_HINT.trimStart())
      console.log('  Created CLAUDE.md with cogitlog reminder')
    } else if (found.length === 0 && replaced.length === 0) {
      console.log(`  Already present in: ${skipped.join(', ')} (use --force to replace)`)
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
      const events = readEvents(p.session(existingId))
      if (!events.some(e => e.type === 'close')) {
        console.error(`Session ${existingId} is already active. Close it first with \`cogitlog close\`.`)
        process.exit(1)
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
    }
    await appendIndex(p.index, p.lock, entry)

    console.log(`Session started: ${sessionId}`)
  })

// ── note ──────────────────────────────────────────────────────────────────────

program
  .command('note <text>')
  .description('Add a note to the current session')
  .option('-f, --file <path>', 'File reference — repeatable (default: auto-detect from git)', collect, [] as string[])
  .action(async (text: string, opts: { file: string[] }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const sessionId = requireActiveSession(vgDir)

    const event: SessionEvent = {
      session_id: sessionId,
      seq: nextSeq(p.session(sessionId)),
      type: 'note',
      at: now(),
      body: text,
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
  .action(async (text: string, opts: { file: string[]; alternative: string[] }) => {
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
      alternatives,
      files: fileRefs(opts.file, getGitRoot()),
    }
    appendEvent(p.session(sessionId), event)
    console.log('Decision recorded')
  })

// ── attempt ───────────────────────────────────────────────────────────────────

program
  .command('attempt <text>')
  .description('Record an attempt')
  .requiredOption('--outcome <outcome>', 'succeeded | failed | partial')
  .option('--reason <text>', 'Why it failed or was partial')
  .option('-f, --file <path>', 'File reference — repeatable', collect, [] as string[])
  .action(async (text: string, opts: { outcome: string; reason?: string; file: string[] }) => {
    const valid: AttemptOutcome[] = ['succeeded', 'failed', 'partial']
    if (!valid.includes(opts.outcome as AttemptOutcome)) {
      console.error(`--outcome must be one of: ${valid.join(', ')}`)
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
      outcome: opts.outcome as AttemptOutcome,
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
  .action(async (text: string, opts: { file: string[] }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const sessionId = requireActiveSession(vgDir)

    const event: SessionEvent = {
      session_id: sessionId,
      seq: nextSeq(p.session(sessionId)),
      type: 'uncertainty',
      at: now(),
      body: text,
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
    const begin = allEvents.find(e => e.type === 'begin') as any

    // Merge tags from begin index entry (if any) with tags passed to close
    const existingEntries = readIndex(p.index)
    const existingEntry = existingEntries.find(e => e.session_id === sessionId)
    const mergedTags = Array.from(new Set([...(existingEntry?.tags ?? []), ...opts.tag]))

    const entry: IndexEntry = {
      session_id: sessionId,
      index_version: 2,
      started_at: begin?.at ?? event.at,
      closed_at: event.at,
      agent: { tool: AGENT_TOOL, model: null },
      git_head: begin?.git_head ?? null,
      intent: begin?.intent ?? '',
      outcome,
      outcome_note: opts.note ?? null,
      files: deriveFiles(allEvents),
      tags: mergedTags,
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
    const entries = readIndex(p.index).filter(e => e.files.some(f => normFile(f) === needle))

    if (entries.length === 0) {
      console.log(`No sessions reference ${file}`)
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

program
  .command('context <file>')
  .description('Show all events (decisions, attempts, notes, uncertainties) related to a file')
  .option('--brief', 'Concise output — last 3 sessions, one line per event')
  .action((file: string, opts: { brief?: boolean }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const needle = normFile(file)
    let entries = readIndex(p.index).filter(e => e.files.some(f => normFile(f) === needle))

    if (entries.length === 0) {
      if (!opts.brief) console.log(`No sessions reference ${file}`)
      return
    }

    if (opts.brief) {
      entries = entries
        .sort((a, b) => (b.started_at > a.started_at ? 1 : -1))
        .slice(0, 3)
    }

    let totalEvents = 0
    for (const entry of entries) {
      const sessionFile = p.session(entry.session_id)
      if (!fs.existsSync(sessionFile)) continue
      const events = readEvents(sessionFile).filter(e =>
        'files' in e && e.files.some(f => normFile(f.path) === needle),
      )
      if (events.length === 0) continue

      totalEvents += events.length

      if (opts.brief) {
        const date = entry.started_at.slice(0, 10)
        console.log(`[${date}] ${entry.intent} (${entry.outcome})`)
        for (const e of events) {
          const body = (e as any).body ?? ''
          const prefix = e.type === 'decision' ? 'decided' :
                         e.type === 'attempt' ? `tried (${(e as any).outcome})` :
                         e.type === 'uncertainty' ? 'uncertain' : 'note'
          console.log(`  ${prefix}: ${body}`)
        }
      } else {
        const date = entry.started_at.slice(0, 10)
        console.log(`\n── ${date} ${entry.session_id}`)
        console.log(`   intent: ${entry.intent} (${entry.outcome})`)

        for (const e of events) {
          const ts = e.at.slice(11, 16)
          const body = (e as any).body ?? ''
          console.log(`   [${ts}] ${e.type.toUpperCase().padEnd(11)} ${body}`)
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

    console.log(`Session : ${id}`)
    console.log(`Intent  : ${begin?.intent ?? '(unknown)'}`)
    if (begin?.context) console.log(`Context : ${begin.context}`)
    if (begin?.resumed_from) console.log(`Resumed : ${begin.resumed_from}`)
    console.log(`Outcome : ${close?.outcome ?? entry?.outcome ?? 'in_progress'}`)
    if (close?.outcome_note) console.log(`Note    : ${close.outcome_note}`)
    if (entry?.tags?.length) console.log(`Tags    : ${entry.tags.join(', ')}`)
    console.log(`Files   : ${entry?.files?.join(', ') || '(none)'}`)
    console.log('')

    for (const e of events) {
      if (e.type === 'begin' || e.type === 'close') continue
      const ts = e.at.slice(11, 16) // HH:MM
      const body = (e as any).body ?? ''
      console.log(`[${ts}] ${e.type.toUpperCase().padEnd(11)} ${body}`)
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
// Output contract (--json):
//   One JSON object per line:
//   { session_id, intent, outcome, started_at, source: "index"|"deep", matching_events: Event[] }
//
//   matching_events is [] when source is "index".

program
  .command('query <text>')
  .description('Search sessions by intent and outcome_note')
  .option('--deep', 'Also search event body fields in session files')
  .option('--json', 'Output as JSONL (one object per match)')
  .action((text: string, opts: { deep?: boolean; json?: boolean }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const needle = text.toLowerCase()
    const entries = readIndex(p.index)

    type Match = { entry: IndexEntry; source: 'index' | 'deep'; matchingEvents: SessionEvent[] }
    const results: Match[] = []

    for (const entry of entries) {
      const inIndex =
        entry.intent.toLowerCase().includes(needle) ||
        (entry.outcome_note ?? '').toLowerCase().includes(needle)

      if (inIndex) {
        results.push({ entry, source: 'index', matchingEvents: [] })
        continue
      }

      if (opts.deep) {
        const sessionFile = p.session(entry.session_id)
        if (!fs.existsSync(sessionFile)) continue
        const events = readEvents(sessionFile)
        const hits = events.filter(e => 'body' in e && (e as any).body.toLowerCase().includes(needle))
        if (hits.length > 0) {
          results.push({ entry, source: 'deep', matchingEvents: hits })
        }
      }
    }

    if (results.length === 0) {
      console.log('No results')
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
        const tag = source === 'deep' ? `[deep +${matchingEvents.length}]` : '[index]'
        console.log(`${tag} ${entry.session_id} — ${entry.intent} (${entry.outcome})`)
        for (const e of matchingEvents) {
          console.log(`  [${e.type}] ${(e as any).body}`)
        }
      }
    }
  })

// ── log ───────────────────────────────────────────────────────────────────────

program
  .command('log')
  .description('List recent sessions')
  .option('-n, --limit <n>', 'Max sessions to show', '20')
  .action((opts: { limit: string }) => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)
    const entries = readIndex(p.index)
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

    if (!id) { console.log('No active session'); return }

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
  .description('Rebuild and deduplicate index.jsonl from session files')
  .action(() => {
    const vgDir = requireVibegitDir()
    const p = vgPaths(vgDir)

    if (!fs.existsSync(p.sessions)) {
      console.log('No sessions directory — nothing to repair')
      return
    }

    const activeId = getCurrentId(p.current)
    const oldEntries = readIndex(p.index)
    const oldTagsMap = new Map(oldEntries.map(e => [e.session_id, e.tags]))
    const files = fs.readdirSync(p.sessions).filter(f => f.endsWith('.jsonl'))
    const entries: IndexEntry[] = []

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '')
      const events = readEvents(path.join(p.sessions, file))
      if (events.length === 0) continue

      const begin = events.find(e => e.type === 'begin') as any
      const close = events.find(e => e.type === 'close') as any

      let outcome: IndexEntry['outcome']
      if (close) outcome = close.outcome
      else if (sessionId === activeId) outcome = 'in_progress'
      else outcome = 'interrupted'

      entries.push({
        session_id: sessionId,
        index_version: 1,
        started_at: begin?.at ?? events[0].at,
        closed_at: close?.at ?? null,
        agent: { tool: AGENT_TOOL, model: null },
        git_head: begin?.git_head ?? null,
        intent: begin?.intent ?? '',
        outcome,
        outcome_note: close?.outcome_note ?? null,
        files: deriveFiles(events),
        tags: oldTagsMap.get(sessionId) ?? [],
      })
    }

    writeIndex(p.index, entries)
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

READING — use these before investigating bugs or understanding past decisions
---------------------------------------------------------------------------
  cogitlog why <file>             # why was this file changed? (decisions only)
  cogitlog context <file>         # all reasoning related to a file
  cogitlog query "<text>"         # search sessions by topic
  cogitlog query "<text>" --deep  # also search event bodies
  cogitlog log                    # list recent sessions
  cogitlog show [session-id]      # full detail of a session

WRITING — use these to record your own reasoning for future agents
------------------------------------------------------------------
At the start of every task, open a session:

  cogitlog begin "<what you intend to do>" [--context "<extra background>"]

During the task, record meaningful events:

  cogitlog note "<observation or progress update>"
  cogitlog decision "<what you chose and why>" [-a "<option:reason rejected>"]
  cogitlog attempt "<what you tried>" --outcome failed --reason "<why it failed>"
  cogitlog uncertainty "<what you don't know or aren't confident about>"

At the end of the task, close the session:

  cogitlog close --outcome <completed|partial|abandoned|interrupted> [--note "<summary>"]

Use interrupted if you hit a context limit or are stopping mid-task.
A future agent can resume with: cogitlog begin "<intent>" --resume <session-id>

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
      const entries = readIndex(p.index)
      console.log(`  No active session.`)
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
  '  cogitlog close --outcome completed --note "Committed: $SUBJECT ($COMMIT)" || true',
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
    const needle = normFile(filePath)
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
      console.log(lines.join('\n'))
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

    const userMessage = input?.message ?? input?.content ?? ''
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
description: Check cogitlog history before working on a file or topic. Usage: /cogitlog-read <file-or-topic> (e.g. /cogitlog-read src/cli.ts, /cogitlog-read "auth flow")
---

## User Input

\`\`\`text
$ARGUMENTS
\`\`\`

Parse the argument to determine if it's a **file path** or a **topic/keyword**.

- If it looks like a file path (contains \`/\` or \`.\`): treat as a file
- Otherwise: treat as a topic

## If File Path

Run these cogitlog queries in parallel:

1. **\`cogitlog_why\`** on the file — to see past decisions that affected it
2. **\`cogitlog_context\`** on the file with \`brief: true\` — to see all reasoning events

## If Topic

Run this cogitlog query:

1. **\`cogitlog_query\`** with \`deep: true\` — to search sessions by topic, including event bodies

## Also Run

- **\`cogitlog_log\`** with \`limit: 5\` — to show recent sessions for general awareness

## Output

Summarize what you found in a concise format:

### Cogitlog Context: {file or topic}

**Recent decisions:**
- (list decisions with session IDs and dates)

**Key notes/events:**
- (list relevant notes, attempts, uncertainties)

**Active session:**
- Whether there's a currently open session (from \`cogitlog_status\`)

If nothing was found, say so clearly: "No prior cogitlog history found for {target}."

## Operating Principles

- This is **read-only** — no sessions are opened, no events are recorded
- Always run this before modifying files that have been touched in prior sessions
- Surface surprises: if a past decision contradicts the current plan, flag it prominently
`

const SKILL_WRITE = `---
description: Open a cogitlog session for the current task. Usage: /cogitlog-write <intent> (e.g. /cogitlog-write "fix redirect loop in auth middleware")
---

## User Input

\`\`\`text
$ARGUMENTS
\`\`\`

The argument is the **intent** — what you're about to do.

## Step 1: Check Current Status

Run **\`cogitlog_status\`** to see if there's already an open session.

- If there's an open session that matches the current intent, **do not open a new one**. Tell the user the session is already open and continue.
- If there's an open session for a *different* task, it will be auto-closed as \`interrupted\` when you open the new one. Warn the user about this before proceeding.

## Step 2: Open the Session

Run **\`cogitlog_begin\`** with:
- \`intent\`: the user's argument
- \`tags\`: infer 1-3 relevant tags from the intent (e.g., \`["bugfix", "auth"]\`, \`["feature", "cli"]\`)

## Step 3: Confirm and Remind

Tell the user:

> Session opened: "{intent}"
>
> During this task, I will log events using:
> - \`cogitlog_decision\` — when making important choices
> - \`cogitlog_note\` — when discovering something relevant
> - \`cogitlog_attempt\` — when trying a solution (with outcome)
> - \`cogitlog_uncertainty\` — when something is unclear
>
> When done, I'll close with \`cogitlog_close\`.

## IMPORTANT — Ongoing Behavior

After opening the session, you MUST continue logging events throughout the rest of the conversation:

- **Before modifying a file**: run \`cogitlog_why\` on it first
- **When you make a non-obvious choice**: log a \`cogitlog_decision\` with alternatives considered
- **When you try something**: log a \`cogitlog_attempt\` with the outcome
- **When you discover something unexpected**: log a \`cogitlog_note\`
- **When you're unsure about something**: log a \`cogitlog_uncertainty\`
- **When the task is done**: run \`cogitlog_close\` with the appropriate outcome

Do NOT forget to close the session. If the user moves on to a different topic without explicitly closing, close the session as \`completed\` or \`partial\` based on what was accomplished.
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

program.parse()
