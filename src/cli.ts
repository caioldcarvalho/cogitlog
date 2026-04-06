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
    console.error('No active session. Run `vibegit begin "<intent>"` first.')
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
  .name('vibegit')
  .description('Semantic memory protocol for AI agents working in codebases')
  .version('0.1.0')

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize .vibegit/ in the current directory')
  .action(() => {
    const vgDir = path.join(process.cwd(), '.vibegit')
    if (fs.existsSync(vgDir)) {
      console.log('.vibegit/ already exists')
      return
    }
    fs.mkdirSync(path.join(vgDir, 'sessions'), { recursive: true })
    fs.writeFileSync(
      path.join(vgDir, 'config.json'),
      JSON.stringify({ spec_version: SPEC_VERSION, created_at: now() }, null, 2) + '\n',
    )
    fs.writeFileSync(path.join(vgDir, 'index.jsonl'), '')
    console.log('Initialized .vibegit/')
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
      const events = readEvents(p.session(existingId))
      if (!events.some(e => e.type === 'close')) {
        console.error(`Session ${existingId} is already active. Close it first with \`vibegit close\`.`)
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
    const entries = readIndex(p.index).filter(e => e.files.includes(file))

    if (entries.length === 0) {
      console.log(`No sessions reference ${file}`)
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
    if (!vgDir) { console.log('Not a vibegit repository'); return }

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
        tags: [],
      })
    }

    writeIndex(p.index, entries)
    console.log(`Rebuilt index: ${entries.length} session(s)`)
  })

// ── hook ─────────────────────────────────────────────────────────────────────

const hookCmd = program.command('hook').description('Manage git hooks for vibegit')

const POST_COMMIT_SCRIPT = [
  '#!/bin/sh',
  '# vibegit post-commit hook — auto-closes active session on commit',
  'if command -v vibegit >/dev/null 2>&1; then',
  '  COMMIT=$(git rev-parse HEAD 2>/dev/null)',
  '  SUBJECT=$(git log -1 --format=%s 2>/dev/null)',
  '  vibegit close --outcome completed --note "Committed: $SUBJECT ($COMMIT)" 2>/dev/null || true',
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
      if (existing.includes('vibegit')) { console.log('Hook already installed'); return }
      fs.appendFileSync(hookFile, '\n' + POST_COMMIT_SCRIPT + '\n')
    } else {
      fs.writeFileSync(hookFile, POST_COMMIT_SCRIPT + '\n', 'utf8')
      fs.chmodSync(hookFile, '755')
    }

    console.log(`Installed post-commit hook: ${hookFile}`)
  })

hookCmd
  .command('uninstall')
  .description('Remove vibegit lines from post-commit hook')
  .action(() => {
    const gitRoot = getGitRoot()
    if (!gitRoot) { console.error('Not inside a git repository'); process.exit(1) }

    const hookFile = path.join(gitRoot, '.git', 'hooks', 'post-commit')
    if (!fs.existsSync(hookFile)) { console.log('No post-commit hook found'); return }

    const content = fs.readFileSync(hookFile, 'utf8')
    if (!content.includes('vibegit')) { console.log('No vibegit hook found'); return }

    const vibegitLines = new Set(POST_COMMIT_SCRIPT.split('\n'))
    const filtered = content.split('\n').filter(line => !vibegitLines.has(line)).join('\n')
    fs.writeFileSync(hookFile, filtered, 'utf8')
    console.log('Removed vibegit hook')
  })

// ─────────────────────────────────────────────────────────────────────────────

program.parse()
