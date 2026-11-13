/**
 * The observer: records a commit's reasoning without anyone remembering to.
 *
 * cogitlog's original failure was asking the agent to log while it worked. An agent
 * in the middle of a task forgets — so does a person. The observer moves the writing
 * out of the actor's hands: on commit, it reads the Claude Code transcript that
 * produced the change, asks a small model to extract decisions, failed attempts and
 * rejected alternatives, and keeps only what it can quote back verbatim.
 *
 * Everything here except `runObserve` is pure, so it can be tested without git,
 * a transcript directory or a model.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'

import { appendEvent, appendIndex, deriveDigest, deriveFiles, deriveLinks, readIndex } from './io'
import { withLock } from './lock'
import { SPEC_VERSION, vgPaths } from './vg'
import type { FileRef, IndexEntry, SessionEvent } from './types'

export const OBSERVER_TOOL = 'cogitlog-observer'
export const OBSERVED_TAG = 'observed'
const DIGEST_CAP = 60_000
const ITEM_CAP = 1_500
const ERROR_CAP = 300

// ─── Transcript collection ───────────────────────────────────────────────────

export interface TranscriptItem {
  at: string
  kind: 'user' | 'assistant' | 'edit' | 'bash' | 'error'
  text: string
}

export function transcriptsDir(): string {
  if (process.env.COGITLOG_TRANSCRIPTS_DIR) return process.env.COGITLOG_TRANSCRIPTS_DIR
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(base, 'projects')
}

/** Inline control tags some agent setups write into replies (memory, effects, private
 *  scratch). They are about the agent, not the code, and never belong in a repo. */
const CONTROL_TAG_RE =
  /<(save|save-global|worklog|callback|think|remember-graph|do)\b[^>]*>[\s\S]*?<\/\1>|<do\b[^>]*\/>/g
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function clean(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').replace(CONTROL_TAG_RE, '').trim()
}

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + ' […]' : text
}

function within(at: string, sinceMs: number, untilMs: number): boolean {
  const t = Date.parse(at)
  return !isNaN(t) && t > sinceMs && t <= untilMs
}

function insideRepo(cwd: unknown, repoRoot: string): boolean {
  if (typeof cwd !== 'string') return false
  const rel = path.relative(repoRoot, cwd)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Read every Claude Code transcript event that happened inside `repoRoot` during
 * the window. Only `user` and `assistant` lines count: transcripts also carry
 * request blobs that repeat the same messages, which would double everything.
 */
export function collectTranscript(
  dir: string,
  repoRoot: string,
  sinceMs: number,
  untilMs: number,
): { items: TranscriptItem[]; sources: string[] } {
  const items: TranscriptItem[] = []
  const sources = new Set<string>()
  if (!fs.existsSync(dir)) return { items, sources: [] }

  for (const project of fs.readdirSync(dir)) {
    const pdir = path.join(dir, project)
    let files: string[]
    try { files = fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const file = path.join(pdir, f)
      try { if (fs.statSync(file).mtimeMs < sinceMs) continue } catch { continue }
      const evts: any[] = []
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let evt: any
        try { evt = JSON.parse(line) } catch { continue }
        if (evt.type !== 'user' && evt.type !== 'assistant') continue
        if (evt.isSidechain || !within(evt.timestamp, sinceMs, untilMs)) continue
        evts.push(evt)
      }
      // The why is usually argued in conversation before anyone cd's into the repo.
      // So a session that worked in the repo contributes all of its CONVERSATION in
      // the window; its tool calls only count when they ran inside the repo.
      if (!evts.some(e => insideRepo(e.cwd, repoRoot))) continue
      const before = items.length
      for (const evt of evts) pushItems(items, evt, repoRoot, insideRepo(evt.cwd, repoRoot))
      if (items.length > before) sources.add(path.basename(f, '.jsonl'))
    }
  }
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return { items, sources: Array.from(sources) }
}

function pushItems(items: TranscriptItem[], evt: any, repoRoot: string, inRepo = true): void {
  const at = evt.timestamp
  const content = evt.message?.content
  if (evt.type === 'user') {
    if (typeof content === 'string') {
      const t = clean(content)
      if (t) items.push({ at, kind: 'user', text: clip(t, ITEM_CAP) })
      return
    }
    if (!Array.isArray(content)) return
    for (const c of content) {
      if (c?.type === 'tool_result' && c.is_error) {
        if (!inRepo) continue
        const raw = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '')
        if (/doesn't want to proceed|tool use was rejected/i.test(raw)) continue
        items.push({ at, kind: 'error', text: clip(clean(raw), ERROR_CAP) })
      } else if (c?.type === 'text' && c.text) {
        const t = clean(c.text)
        if (t) items.push({ at, kind: 'user', text: clip(t, ITEM_CAP) })
      }
    }
    return
  }
  if (!Array.isArray(content)) return
  for (const c of content) {
    if (c?.type === 'text' && c.text) {
      const t = clean(c.text)
      if (t) items.push({ at, kind: 'assistant', text: clip(t, ITEM_CAP) })
    } else if (c?.type === 'tool_use' && inRepo) {
      const input = c.input ?? {}
      if (typeof input.file_path === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) {
        items.push({ at, kind: 'edit', text: relPath(input.file_path, repoRoot) })
      } else if (c.name === 'Bash' && typeof input.command === 'string') {
        items.push({ at, kind: 'bash', text: clip(input.command.split('\n')[0], 200) })
      }
    }
  }
}

export function relPath(file: string, repoRoot: string): string {
  if (!path.isAbsolute(file)) return path.normalize(file).replace(/^\.\//, '')
  const rel = path.relative(repoRoot, file)
  return rel.startsWith('..') ? file : rel
}

// ─── Digest ───────────────────────────────────────────────────────────────────

export interface CommitInfo {
  sha: string
  subject: string
  stat: string
  files: string[]
}

/** The text the model reads. Over the cap, the oldest lines go: the reasoning
 *  that shaped a commit usually sits close to it. */
export function buildDigest(items: TranscriptItem[], commit: CommitInfo, cap = DIGEST_CAP): string {
  const header = `COMMIT ${commit.sha.slice(0, 12)}: ${commit.subject}\n${commit.stat}\n\nTRANSCRIPT\n`
  const lines = items.map(i => `[${i.kind}] ${i.text}`)
  let body = lines.join('\n')
  if (header.length + body.length > cap) {
    const keep: string[] = []
    let size = header.length + 40
    for (let i = lines.length - 1; i >= 0; i--) {
      if (size + lines[i].length + 1 > cap) break
      keep.unshift(lines[i])
      size += lines[i].length + 1
    }
    body = '[… earlier transcript omitted …]\n' + keep.join('\n')
  }
  return header + body
}

// ─── Privacy ──────────────────────────────────────────────────────────────────

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[secret]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[secret]'],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g, '[secret]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret]'],
  [/(?<![\w.])\+?\d{1,3}[\s.-]?\(?\d{2,3}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}\b/g, '[phone]'],
]

export function redact(text: string, home = os.homedir()): string {
  let out = text
  if (home && home !== '/') out = out.split(home).join('~')
  out = out.replace(/\/(?:home|Users)\/[^/\s]+/g, '~')
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep)
  return out
}

// ─── Extraction ───────────────────────────────────────────────────────────────

export interface ObservedEvent {
  type: 'decision' | 'attempt' | 'note' | 'uncertainty'
  description: string
  body: string
  evidence: string
  files: string[]
  alternatives?: Array<{ option: string; reason_rejected: string }>
  outcome?: 'succeeded' | 'failed' | 'partial'
  reason?: string | null
  technical?: boolean
}

export interface Extraction {
  intent: string
  events: ObservedEvent[]
}

export function extractionPrompt(digest: string, isPublic: boolean): string {
  return `You are reading the transcript of a coding session that ended in a git commit.
Extract the REASONING behind the commit, the part that git does not keep.

Record only what a future developer would want before touching this code:
- decision: a choice between options. Put the rejected options in "alternatives".
- attempt: something tried. Failed and partial attempts matter most — they stop the
  next person from walking into the same dead end. Give the cause in "reason".
- uncertainty: a doubt that was left open.
- note: a non-obvious fact about the code or its environment.

Rules:
- Technical content only: code, architecture, tools, bugs, constraints. Never record
  feelings, personal life, people's names, jokes, or how the conversation went.
- "evidence" must be an EXACT, contiguous quote (10-200 chars) copied from the
  transcript below that supports the event. Do not paraphrase it.
- "files": only paths that appear in the commit stat.
- "description": one line, under 100 chars. "body": 1-3 sentences.
- Set "technical": false on anything that is not purely technical${isPublic
    ? `. This repository is PUBLIC: when in doubt, mark it false.` : '.'}
- Nothing worth recording? Return an empty "events" list. Five good events beat
  fifteen weak ones.

Reply with ONLY this JSON, no prose, no code fence:
{"intent": "<one line: what the session set out to do>",
 "events": [{"type": "decision|attempt|note|uncertainty", "description": "...", "body": "...",
   "evidence": "...", "files": ["..."], "technical": true,
   "alternatives": [{"option": "...", "reason_rejected": "..."}],
   "outcome": "succeeded|failed|partial", "reason": "..."}]}

${digest}`
}

/** Pull the JSON object out of a model reply that may carry a fence or prose. */
export function parseExtraction(raw: string): Extraction | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1))
    if (!obj || !Array.isArray(obj.events)) return null
    return { intent: String(obj.intent ?? '').trim(), events: obj.events }
  } catch {
    return null
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The anti-hallucination gate. An event survives only if its evidence is really in
 * the transcript, its type is known, and it was not flagged as non-technical.
 * Files are cut down to the ones the commit actually touched.
 */
export function validateEvents(ex: Extraction, digest: string, commitFiles: string[]): ObservedEvent[] {
  const hay = squash(digest)
  const allowed = new Set(commitFiles)
  const types = new Set(['decision', 'attempt', 'note', 'uncertainty'])
  const out: ObservedEvent[] = []
  for (const e of ex.events as any[]) {
    if (!e || !types.has(e.type)) continue
    if (e.technical === false) continue
    const evidence = String(e.evidence ?? '')
    if (squash(evidence).length < 10 || !hay.includes(squash(evidence))) continue
    const body = String(e.body ?? '').trim()
    const description = String(e.description ?? '').trim().slice(0, 120)
    if (!body && !description) continue
    const ev: ObservedEvent = {
      type: e.type,
      description,
      body: body || description,
      evidence,
      files: Array.isArray(e.files) ? e.files.map(String).filter((f: string) => allowed.has(f)) : [],
    }
    if (e.type === 'decision' && Array.isArray(e.alternatives)) {
      ev.alternatives = e.alternatives
        .filter((a: any) => a && a.option)
        .map((a: any) => ({ option: String(a.option), reason_rejected: String(a.reason_rejected ?? '') }))
    }
    if (e.type === 'attempt') {
      ev.outcome = ['succeeded', 'failed', 'partial'].includes(e.outcome) ? e.outcome : 'partial'
      ev.reason = e.reason ? String(e.reason) : null
    }
    out.push(ev)
  }
  return out
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

export interface ObserverConfig {
  owners: string[]
  model?: string
}

export function configFile(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  return path.join(base, 'cogitlog', 'config.json')
}

export function loadConfig(): ObserverConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    return { owners: Array.isArray(raw.owners) ? raw.owners.map(String) : [], model: raw.model }
  } catch {
    return { owners: [] }
  }
}

export function saveConfig(cfg: ObserverConfig): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n')
}

/** owner/repo from a GitHub remote, or null for anything else. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

/** Repos with no remote are always yours. Otherwise the remote's owner must be listed. */
export function isEligible(remoteUrl: string | null, owners: string[]): boolean {
  if (!remoteUrl) return true
  const gh = parseGitHubRemote(remoteUrl)
  const lower = owners.map(o => o.toLowerCase())
  if (gh) return lower.includes(gh.owner.toLowerCase())
  return lower.some(o => remoteUrl.toLowerCase().includes(`/${o}/`) || remoteUrl.toLowerCase().includes(`:${o}/`))
}

// ─── Running it ───────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** Public unless proven private. Cached in git config so `gh` runs once per clone. */
export function repoIsPublic(repoRoot: string, remoteUrl: string | null): boolean {
  const cached = git(['config', '--get', 'cogitlog.public'], repoRoot)
  if (cached === 'true' || cached === 'false') return cached === 'true'
  if (!remoteUrl) return false
  let result = true
  const gh = parseGitHubRemote(remoteUrl)
  if (gh) {
    const r = spawnSync('gh', ['api', `repos/${gh.owner}/${gh.repo}`, '--jq', '.private'], {
      encoding: 'utf8', timeout: 15_000,
    })
    if (r.status === 0 && r.stdout.trim() === 'true') result = false
    if (r.status !== 0) return true // unknown: do not cache, treat as public
  }
  git(['config', 'cogitlog.public', String(result)], repoRoot)
  return result
}

export type ModelRunner = (prompt: string, model: string) => string | null

export const claudeRunner: ModelRunner = (prompt, model) => {
  // An empty temp dir as cwd + project-only settings: the extraction call must not
  // load the user's hooks, read a CLAUDE.md, or leave a transcript that a later
  // commit would observe.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cogitlog-observe-'))
  try {
    const r = spawnSync('claude', [
      '-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
      '--setting-sources', 'project', '--tools', '',
    ], {
      cwd, input: prompt, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, COGITLOG_OBSERVING: '1' },
    })
    if (r.status !== 0) return null
    try {
      const wrapped = JSON.parse(r.stdout)
      return typeof wrapped.result === 'string' ? wrapped.result : r.stdout
    } catch {
      return r.stdout
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

function makeSessionId(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${ts}-${crypto.randomBytes(4).toString('hex')}`
}

/** Create a bare store. Unlike `init`, it never touches the repo's instruction files:
 *  an automatic process has no business editing someone's CLAUDE.md. */
export function ensureStore(repoRoot: string): string {
  const vgDir = path.join(repoRoot, '.cogitlog')
  const p = vgPaths(vgDir)
  fs.mkdirSync(p.sessions, { recursive: true })
  if (!fs.existsSync(p.config)) {
    fs.writeFileSync(p.config, JSON.stringify({ spec_version: SPEC_VERSION, created_at: new Date().toISOString() }, null, 2) + '\n')
  }
  if (!fs.existsSync(p.index)) fs.writeFileSync(p.index, '')
  const agents = path.join(vgDir, 'AGENTS.md')
  if (!fs.existsSync(agents)) {
    fs.writeFileSync(agents,
      'This directory records why this repo\'s changes were made: decisions, failed attempts\n' +
      'and rejected alternatives. Read it before rewriting code that looks arbitrary:\n' +
      '`cogitlog why <file>`, `cogitlog query "<topic>"`, or read sessions/*.jsonl directly.\n')
  }
  const ignore = path.join(vgDir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'observe.log\nlock\ncurrent\n')
  return vgDir
}

export interface ObserveOptions {
  repoRoot: string
  commit?: string
  auto?: boolean
  dryRun?: boolean
  model?: string
  runner?: ModelRunner
  log?: (msg: string) => void
}

export interface ObserveResult {
  status: 'written' | 'skipped' | 'empty' | 'failed' | 'dry-run'
  reason?: string
  sessionId?: string
  events?: ObservedEvent[]
}

export async function runObserve(opts: ObserveOptions): Promise<ObserveResult> {
  const { repoRoot } = opts
  const log = opts.log ?? (() => {})
  const sha = opts.commit || git(['rev-parse', 'HEAD'], repoRoot)
  if (!sha) return { status: 'skipped', reason: 'no commit' }

  const gitDir = git(['rev-parse', '--absolute-git-dir'], repoRoot)
  const remote = git(['remote', 'get-url', 'origin'], repoRoot) || null
  const cfg = loadConfig()

  if (opts.auto) {
    if (process.env.COGITLOG_SKIP || process.env.COGITLOG_OBSERVING) return { status: 'skipped', reason: 'env' }
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
      if (gitDir && fs.existsSync(path.join(gitDir, marker))) return { status: 'skipped', reason: marker }
    }
    if (!isEligible(remote, cfg.owners)) return { status: 'skipped', reason: 'not an owned repo' }
    if (git(['config', '--get', 'cogitlog.observe'], repoRoot) === 'false') return { status: 'skipped', reason: 'opted out' }
  }

  const untilIso = git(['show', '-s', '--format=%cI', sha], repoRoot)
  const prevIso = git(['show', '-s', '--format=%cI', `${sha}^`], repoRoot)
  const untilMs = Date.parse(untilIso)
  if (isNaN(untilMs)) return { status: 'failed', reason: 'cannot read commit time' }
  const sinceMs = prevIso ? Date.parse(prevIso) : untilMs - 6 * 3600_000

  const vgDirExisting = path.join(repoRoot, '.cogitlog')
  if (fs.existsSync(path.join(vgDirExisting, 'index.jsonl'))) {
    const index = readIndex(vgPaths(vgDirExisting).index)
    const tag = `commit:${sha.slice(0, 12)}`
    if (index.some(e => e.tags.includes(tag))) return { status: 'skipped', reason: 'already observed' }
    // A session someone wrote by hand during this window wins over the observer.
    const manual = index.some(e => !e.tags.includes(OBSERVED_TAG)
      && Date.parse(e.started_at) <= untilMs
      && (e.closed_at === null || Date.parse(e.closed_at) > sinceMs)
      && (e.digest ?? []).some(d => d.type !== 'begin' && d.type !== 'close'))
    if (manual) return { status: 'skipped', reason: 'a recorded session covers this commit' }
  }

  const { items, sources } = collectTranscript(transcriptsDir(), repoRoot, sinceMs, untilMs)
  if (items.length === 0) return { status: 'empty', reason: 'no transcript in window' }

  const files = git(['show', '--name-only', '--format=', sha], repoRoot).split('\n').filter(Boolean)
  const commit: CommitInfo = {
    sha,
    subject: git(['show', '-s', '--format=%s', sha], repoRoot),
    stat: git(['show', '--stat', '--format=', sha], repoRoot),
    files,
  }
  const digest = redact(buildDigest(items, commit))
  const isPublic = repoIsPublic(repoRoot, remote)
  const model = opts.model ?? cfg.model ?? 'haiku'
  log(`observing ${sha.slice(0, 12)}: ${items.length} transcript items, public=${isPublic}, model=${model}`)

  const raw = (opts.runner ?? claudeRunner)(extractionPrompt(digest, isPublic), model)
  if (!raw) return { status: 'failed', reason: 'model call failed' }
  const ex = parseExtraction(raw)
  if (!ex) return { status: 'failed', reason: 'unparseable model reply' }
  const events = validateEvents(ex, digest, files).map(e => ({
    ...e,
    description: redact(e.description),
    body: redact(e.body),
    reason: e.reason ? redact(e.reason) : e.reason,
  }))
  log(`model proposed ${ex.events.length} event(s), ${events.length} survived validation`)
  if (events.length === 0) return { status: 'empty', reason: 'nothing survived validation' }
  if (opts.dryRun) return { status: 'dry-run', events }

  const vgDir = ensureStore(repoRoot)
  const p = vgPaths(vgDir)
  const sessionId = makeSessionId(new Date(untilMs))
  const sessionFile = p.session(sessionId)
  const ref = (f: string): FileRef => ({ path: f, base_commit: sha, dirty: false })
  const at = new Date().toISOString()
  const intent = redact(ex.intent || commit.subject).slice(0, 200)

  const all: SessionEvent[] = [{
    session_id: sessionId, seq: 0, type: 'begin', at, intent,
    context: `observed from Claude Code transcript ${sources.join(', ')} for commit ${sha.slice(0, 12)}`,
    git_head: sha, resumed_from: null, source: 'observer',
  } as SessionEvent]
  events.forEach((e, i) => {
    const base = {
      session_id: sessionId, seq: i + 1, at, body: e.body, description: e.description || null,
      links: [], files: e.files.map(ref), source: 'observer', evidence: e.evidence,
    }
    if (e.type === 'decision') all.push({ ...base, type: 'decision', alternatives: e.alternatives ?? [] } as SessionEvent)
    else if (e.type === 'attempt') all.push({ ...base, type: 'attempt', outcome: e.outcome ?? 'partial', reason: e.reason ?? null } as SessionEvent)
    else all.push({ ...base, type: e.type } as SessionEvent)
  })
  all.push({
    session_id: sessionId, seq: events.length + 1, type: 'close', at, outcome: 'completed',
    outcome_note: `Committed: ${commit.subject} (${sha})`, files: files.map(ref),
  } as SessionEvent)

  await withLock(p.lock, () => { for (const e of all) appendEvent(sessionFile, e) })
  const entry: IndexEntry = {
    session_id: sessionId,
    index_version: 1,
    started_at: at,
    closed_at: at,
    agent: { tool: OBSERVER_TOOL, model },
    git_head: sha,
    intent,
    outcome: 'completed',
    outcome_note: `Committed: ${commit.subject} (${sha})`,
    files: deriveFiles(all),
    tags: [OBSERVED_TAG, `commit:${sha.slice(0, 12)}`],
    digest: deriveDigest(all),
    links: deriveLinks(all),
  }
  await appendIndex(p.index, p.lock, entry)
  log(`wrote session ${sessionId} with ${events.length} event(s)`)
  return { status: 'written', sessionId, events }
}
