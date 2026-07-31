import fs from 'fs'
import path from 'path'
import { withLock } from './lock'
import { AGENT_TOOL, vgPaths } from './vg'
import type { DigestEntry, IndexEntry, SessionEvent } from './types'

// ─── Raw file helpers ────────────────────────────────────────────────────────

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim())
}

// ─── Session files ────────────────────────────────────────────────────────────

export function readEvents(sessionFile: string): SessionEvent[] {
  return readLines(sessionFile).flatMap(line => {
    try { return [JSON.parse(line) as SessionEvent] } catch { return [] }
  })
}

export function appendEvent(sessionFile: string, event: SessionEvent): void {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  fs.appendFileSync(sessionFile, JSON.stringify(event) + '\n', 'utf8')
}

export function nextSeq(sessionFile: string): number {
  const lines = readLines(sessionFile)
  if (lines.length === 0) return 0
  try {
    return (JSON.parse(lines[lines.length - 1]) as SessionEvent).seq + 1
  } catch {
    return lines.length
  }
}

/** Union of all file paths across all events in a session. */
export function deriveFiles(events: SessionEvent[]): string[] {
  const set = new Set<string>()
  for (const e of events) {
    if ('files' in e) for (const f of e.files) set.add(f.path)
  }
  return Array.from(set)
}

// ─── Descriptions (spec 0.4) ──────────────────────────────────────────────────

export const DESCRIPTION_MAX = 120

/** Session ids referenced inline as `[[session-id]]`. */
export function parseInlineLinks(text: string): string[] {
  return Array.from(text.matchAll(/\[\[([^\]]+)\]\]/g)).map(m => m[1].trim()).filter(Boolean)
}

/**
 * The one-line summary of an event.
 *
 * Explicit `description` wins. Otherwise the first line of the body is used —
 * which is what makes events written before spec 0.4 scannable too, without a
 * rewrite of existing stores.
 */
export function describeEvent(e: SessionEvent): string {
  const explicit = (e as any).description
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()

  if (e.type === 'close') {
    return e.outcome_note?.trim() || `closed: ${e.outcome}`
  }
  if (e.type === 'begin') return e.intent

  const body = String((e as any).body ?? '').trim()
  const firstLine = body.split('\n')[0].trim()
  if (firstLine.length <= DESCRIPTION_MAX) return firstLine
  return firstLine.slice(0, DESCRIPTION_MAX - 1).trimEnd() + '…'
}

/** One description per event, skipping begin/close (already in the index header). */
export function deriveDigest(events: SessionEvent[]): DigestEntry[] {
  return events
    .filter(e => e.type !== 'begin' && e.type !== 'close')
    .map(e => ({ seq: e.seq, type: e.type, description: describeEvent(e) }))
}

/** Union of every `links` array across a session's events. */
export function deriveLinks(events: SessionEvent[]): string[] {
  const set = new Set<string>()
  for (const e of events) {
    for (const l of (e as any).links ?? []) set.add(l)
    if (e.type === 'begin' && e.resumed_from) set.add(e.resumed_from)
  }
  return Array.from(set)
}

// ─── Index ────────────────────────────────────────────────────────────────────

export function readIndex(indexFile: string): IndexEntry[] {
  const map = new Map<string, IndexEntry>()
  for (const line of readLines(indexFile)) {
    try {
      const e = JSON.parse(line) as IndexEntry
      const existing = map.get(e.session_id)
      if (!existing || e.index_version > existing.index_version) map.set(e.session_id, e)
    } catch { /* skip corrupt line */ }
  }
  return Array.from(map.values())
}

export async function appendIndex(indexFile: string, lockFile: string, entry: IndexEntry): Promise<void> {
  await withLock(lockFile, () => {
    fs.appendFileSync(indexFile, JSON.stringify(entry) + '\n', 'utf8')
  })
}

export function writeIndex(indexFile: string, entries: IndexEntry[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
  fs.writeFileSync(indexFile, content, 'utf8')
}

// ─── Index rebuild & health ───────────────────────────────────────────────────

/** Session ids present on disk under sessions/. */
export function sessionIdsOnDisk(sessionsDir: string): string[] {
  if (!fs.existsSync(sessionsDir)) return []
  return fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace(/\.jsonl$/, ''))
}

/**
 * Derive one index entry per session file, without writing anything.
 *
 * Anything the session files cannot express — tags, and the index_version
 * counter — is carried over from the current index so a rebuild never costs
 * information.
 */
export function buildEntriesFromSessions(vgDir: string): IndexEntry[] {
  const p = vgPaths(vgDir)
  const activeId = getCurrentId(p.current)
  const previous = new Map(readIndex(p.index).map(e => [e.session_id, e]))
  const entries: IndexEntry[] = []

  for (const sessionId of sessionIdsOnDisk(p.sessions)) {
    const events = readEvents(p.session(sessionId))
    if (events.length === 0) continue

    const begin = events.find(e => e.type === 'begin')
    const close = events.find(e => e.type === 'close')
    const prev = previous.get(sessionId)

    let outcome: IndexEntry['outcome']
    if (close) outcome = close.outcome
    else if (sessionId === activeId) outcome = 'in_progress'
    else outcome = 'interrupted'

    entries.push({
      session_id: sessionId,
      index_version: prev?.index_version ?? 1,
      started_at: begin?.at ?? events[0].at,
      closed_at: close?.at ?? null,
      agent: prev?.agent ?? { tool: AGENT_TOOL, model: null },
      git_head: begin?.git_head ?? null,
      intent: begin?.intent ?? '',
      outcome,
      outcome_note: close?.outcome_note ?? null,
      files: deriveFiles(events),
      tags: prev?.tags ?? [],
      digest: deriveDigest(events),
      links: deriveLinks(events),
    })
  }

  entries.sort((a, b) => (a.started_at < b.started_at ? -1 : 1))
  return entries
}

/** Rebuild index.jsonl from the session files, which are the source of truth. */
export function rebuildIndex(vgDir: string): IndexEntry[] {
  const entries = buildEntriesFromSessions(vgDir)
  writeIndex(vgPaths(vgDir).index, entries)
  return entries
}

export type IndexHealth =
  | { state: 'ok' }
  | { state: 'not_a_store' }
  /** Sessions on disk, no usable index — safe to rebuild, nothing to lose. */
  | { state: 'missing'; sessions: number }
  /** Index exists but does not cover every session file. */
  | { state: 'stale'; sessions: number; indexed: number }

/**
 * Compare the session files against the index.
 *
 * The failure this exists for: a store created by an older version has only
 * sessions/, and every read command answered "nothing here" — indistinguishable
 * from an empty repository.
 */
export function checkIndexHealth(vgDir: string): IndexHealth {
  const p = vgPaths(vgDir)
  const onDisk = sessionIdsOnDisk(p.sessions)
  if (onDisk.length === 0) return { state: 'not_a_store' }

  const indexed = new Set(readIndex(p.index).map(e => e.session_id))
  if (indexed.size === 0) return { state: 'missing', sessions: onDisk.length }

  const uncovered = onDisk.filter(id => !indexed.has(id))
  if (uncovered.length > 0) {
    return { state: 'stale', sessions: onDisk.length, indexed: indexed.size }
  }
  return { state: 'ok' }
}

// ─── Current session pointer ──────────────────────────────────────────────────

export function getCurrentId(currentFile: string): string | null {
  if (!fs.existsSync(currentFile)) return null
  return fs.readFileSync(currentFile, 'utf8').trim() || null
}

export async function setCurrentId(currentFile: string, lockFile: string, id: string): Promise<void> {
  await withLock(lockFile, () => {
    fs.writeFileSync(currentFile, id + '\n', 'utf8')
  })
}

export async function clearCurrentId(currentFile: string, lockFile: string): Promise<void> {
  await withLock(lockFile, () => {
    if (fs.existsSync(currentFile)) fs.unlinkSync(currentFile)
  })
}

// ─── Interrupted session detection ───────────────────────────────────────────

/**
 * If `current` exists but the session has a close event, delete `current` (clean close, missing cleanup).
 * If `current` exists and session has no close event, the session is interrupted — leave as-is.
 */
export function resolveInterrupted(vgDir: string): void {
  const p = vgPaths(vgDir)
  const id = getCurrentId(p.current)
  if (!id) return

  const sessionFile = p.session(id)
  if (!fs.existsSync(sessionFile)) return

  const events = readEvents(sessionFile)
  if (events.some(e => e.type === 'close')) {
    // Closed cleanly but current wasn't deleted
    try { fs.unlinkSync(p.current) } catch { /* already gone */ }
  }
}
