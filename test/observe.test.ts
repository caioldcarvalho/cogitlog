import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

import {
  buildDigest,
  collectTranscript,
  isEligible,
  parseExtraction,
  parseGitHubRemote,
  redact,
  runObserve,
  validateEvents,
} from '../src/observe'

const REPO = '/work/proj'
const T0 = Date.parse('2026-11-13T10:00:00Z')
const T1 = Date.parse('2026-11-13T12:00:00Z')

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cogitlog-test-'))
}

function transcript(dir: string, name: string, events: object[]): void {
  const pdir = path.join(dir, '-work-proj')
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, name), events.map(e => JSON.stringify(e)).join('\n') + '\n')
}

const at = (h: number) => new Date(Date.UTC(2026, 10, 13, h)).toISOString()
const user = (text: string, ts = at(11), cwd = REPO) =>
  ({ type: 'user', cwd, timestamp: ts, message: { role: 'user', content: text } })
const assistant = (content: object[], ts = at(11), cwd = REPO) =>
  ({ type: 'assistant', cwd, timestamp: ts, message: { role: 'assistant', content } })

// ─── collectTranscript ───────────────────────────────────────────────────────

test('collects user, assistant, edits, bash and errors inside the repo and window', () => {
  const dir = tmp()
  transcript(dir, 's1.jsonl', [
    user('use sqlite, not postgres'),
    assistant([
      { type: 'text', text: 'Going with sqlite.' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/work/proj/src/db.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test\necho done' } },
    ]),
    { type: 'user', cwd: REPO, timestamp: at(11), message: { role: 'user', content: [
      { type: 'tool_result', is_error: true, content: 'Error: SQLITE_BUSY' }] } },
  ])
  const { items, sources } = collectTranscript(dir, REPO, T0, T1)
  assert.deepEqual(items.map(i => i.kind), ['user', 'assistant', 'edit', 'bash', 'error'])
  assert.equal(items[2].text, 'src/db.ts')
  assert.equal(items[3].text, 'npm test')
  assert.deepEqual(sources, ['s1'])
})

test('ignores other repos, the time window, sidechains and duplicated request blobs', () => {
  const dir = tmp()
  transcript(dir, 's1.jsonl', [
    user('outside the window', at(9)),
    { ...user('sidechain'), isSidechain: true },
    { type: 'api-request-blob', cwd: REPO, timestamp: at(11), message: { role: 'user', content: 'dup' } },
    user('kept'),
  ])
  transcript(dir, 's2.jsonl', [user('other repo, other session', at(11), '/work/other')])
  const { items } = collectTranscript(dir, REPO, T0, T1)
  assert.deepEqual(items.map(i => i.text), ['kept'])
})

test('subdirectories of the repo count; a sibling with the same prefix does not', () => {
  const dir = tmp()
  transcript(dir, 's1.jsonl', [user('sub', at(11), '/work/proj/pkg')])
  transcript(dir, 's2.jsonl', [user('sibling', at(11), '/work/project2')])
  assert.deepEqual(collectTranscript(dir, REPO, T0, T1).items.map(i => i.text), ['sub'])
})

test('a session that touched the repo brings its conversation, but not its outside tool calls', () => {
  const dir = tmp()
  transcript(dir, 's1.jsonl', [
    user('lets keep the store in the repo', at(10), '/work/elsewhere'),
    assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls elsewhere' } }], at(10), '/work/elsewhere'),
    user('now build it', at(11)),
  ])
  transcript(dir, 's2.jsonl', [user('unrelated session', at(11), '/work/elsewhere')])
  const texts = collectTranscript(dir, REPO, T0 - 3600_000, T1).items.map(i => i.text)
  assert.deepEqual(texts, ['lets keep the store in the repo', 'now build it'])
})

test('strips system reminders, inline control tags and rejected tool calls', () => {
  const dir = tmp()
  transcript(dir, 's1.jsonl', [
    user('fix it <system-reminder>secret context</system-reminder>'),
    assistant([{ type: 'text', text: 'Done. <save desc="x">my private memory</save><do op="speak">hi</do>' }]),
    { type: 'user', cwd: REPO, timestamp: at(11), message: { role: 'user', content: [
      { type: 'tool_result', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } },
  ])
  const texts = collectTranscript(dir, REPO, T0, T1).items.map(i => i.text)
  assert.deepEqual(texts, ['fix it', 'Done.'])
})

// ─── digest, privacy ─────────────────────────────────────────────────────────

test('digest keeps the newest lines when over the cap', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ at: at(11), kind: 'user' as const, text: `line ${i} `.repeat(10) }))
  const d = buildDigest(items, { sha: 'a'.repeat(40), subject: 's', stat: '', files: [] }, 2000)
  assert.ok(d.length <= 2000)
  assert.ok(d.includes('line 49'))
  assert.ok(!d.includes('line 0 '))
  assert.ok(d.includes('earlier transcript omitted'))
})

test('redacts home paths, emails, tokens and phone numbers', () => {
  const out = redact('see /home/ana/x and /Users/bob/y, mail ana@ex.com, ghp_' + 'a'.repeat(30) +
    ' sk-' + 'b'.repeat(30) + ' call +55 11 98765-4321', '/home/ana')
  assert.ok(!out.includes('/home/ana') && !out.includes('/Users/bob'))
  assert.ok(out.includes('~/x') && out.includes('~/y'))
  assert.ok(out.includes('[email]'))
  assert.equal((out.match(/\[secret\]/g) ?? []).length, 2)
  assert.ok(out.includes('[phone]'))
})

// ─── extraction gate ─────────────────────────────────────────────────────────

const DIGEST = 'COMMIT abc: x\n src/db.ts | 3 +\n\nTRANSCRIPT\n[user] use sqlite,   not postgres because it is one file\n[error] Error: SQLITE_BUSY when two writers'

test('parses JSON wrapped in a code fence', () => {
  const ex = parseExtraction('```json\n{"intent":"x","events":[]}\n```')
  assert.deepEqual(ex, { intent: 'x', events: [] })
  assert.equal(parseExtraction('no json here'), null)
})

test('drops events whose evidence is not in the transcript, and non-technical ones', () => {
  const events = validateEvents({ intent: 'x', events: [
    { type: 'decision', description: 'sqlite', body: 'chose sqlite', evidence: 'use sqlite, not postgres', files: ['src/db.ts', 'README.md'],
      alternatives: [{ option: 'postgres', reason_rejected: 'server' }] },
    { type: 'decision', description: 'invented', body: 'made up', evidence: 'we picked redis for caching', files: [] },
    { type: 'note', description: 'tired', body: 'user was tired', evidence: 'Error: SQLITE_BUSY', files: [], technical: false },
    { type: 'attempt', description: 'two writers', body: 'busy', evidence: 'sqlite_busy when two', files: [], outcome: 'weird' },
    { type: 'rant', description: 'x', body: 'x', evidence: 'use sqlite, not postgres', files: [] },
  ] as any }, DIGEST, ['src/db.ts'])
  assert.deepEqual(events.map(e => e.description), ['sqlite', 'two writers'])
  assert.deepEqual(events[0].files, ['src/db.ts'])          // README.md not in the commit
  assert.equal(events[0].alternatives?.[0].option, 'postgres')
  assert.equal(events[1].outcome, 'partial')                // unknown outcome normalised
})

// ─── eligibility ─────────────────────────────────────────────────────────────

test('eligibility: no remote is yours, otherwise the owner must be listed', () => {
  assert.deepEqual(parseGitHubRemote('git@github.com:Ana/repo.git'), { owner: 'Ana', repo: 'repo' })
  assert.deepEqual(parseGitHubRemote('https://github.com/ana/repo'), { owner: 'ana', repo: 'repo' })
  assert.equal(isEligible(null, []), true)
  assert.equal(isEligible('git@github.com:ana/repo.git', ['Ana']), true)
  assert.equal(isEligible('https://github.com/upstream/repo.git', ['ana']), false)
  assert.equal(isEligible('https://github.com/ana/repo.git', []), false)
})

// ─── end to end with a fake model ───────────────────────────────────────────

function gitRepo(): string {
  const dir = fs.realpathSync(tmp())
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  g('init', '-q')
  g('config', 'core.hooksPath', '/dev/null')
  fs.writeFileSync(path.join(dir, 'a.txt'), '1')
  g('add', '.'); g('commit', '-qm', 'first')
  fs.writeFileSync(path.join(dir, 'db.ts'), 'sqlite')
  g('add', '.'); g('commit', '-qm', 'use sqlite')
  g('config', 'cogitlog.public', 'false')
  return dir
}

test('runObserve writes an observed session, once per commit', async () => {
  const repo = gitRepo()
  const tdir = tmp()
  process.env.COGITLOG_TRANSCRIPTS_DIR = tdir
  const now = new Date().toISOString()
  transcript(tdir, 's1.jsonl', [
    user('use sqlite, not postgres: it is one file', now, repo),
    assistant([{ type: 'tool_use', name: 'Write', input: { file_path: path.join(repo, 'db.ts') } }], now, repo),
  ])
  // commit time has 1s resolution and comes after the transcript lines
  const reply = JSON.stringify({ intent: 'pick a database', events: [
    { type: 'decision', description: 'sqlite over postgres', body: 'One file, no server.',
      evidence: 'use sqlite, not postgres', files: ['db.ts'], technical: true,
      alternatives: [{ option: 'postgres', reason_rejected: 'needs a server' }] }] })
  const runner = () => reply

  // the commit happened before the transcript was written in this test, so widen the window
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  execFileSync('git', ['commit', '--amend', '-qm', 'use sqlite', '--no-verify'], { cwd: repo, stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_COMMITTER_DATE: new Date(Date.now() + 5000).toISOString(),
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  void sha

  const r = await runObserve({ repoRoot: repo, runner })
  assert.equal(r.status, 'written', r.reason)
  const index = fs.readFileSync(path.join(repo, '.cogitlog', 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(index.length, 1)
  assert.ok(index[0].tags.includes('observed'))
  const events = fs.readFileSync(path.join(repo, '.cogitlog', 'sessions', `${r.sessionId}.jsonl`), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(events.map(e => e.type), ['begin', 'decision', 'close'])
  assert.equal(events[1].source, 'observer')
  assert.equal(events[1].files[0].path, 'db.ts')

  const again = await runObserve({ repoRoot: repo, runner })
  assert.equal(again.status, 'skipped')
  assert.equal(again.reason, 'already observed')
})

test('runObserve --auto skips repos owned by someone else', async () => {
  const repo = gitRepo()
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/someone-else/x.git'], { cwd: repo })
  process.env.XDG_CONFIG_HOME = tmp()
  const r = await runObserve({ repoRoot: repo, auto: true, runner: () => { throw new Error('must not run') } })
  assert.equal(r.status, 'skipped')
  assert.equal(r.reason, 'not an owned repo')
})

test('runObserve --auto respects git config cogitlog.observe=false', async () => {
  const repo = gitRepo()
  execFileSync('git', ['config', 'cogitlog.observe', 'false'], { cwd: repo })
  const r = await runObserve({ repoRoot: repo, auto: true, runner: () => { throw new Error('must not run') } })
  assert.equal(r.reason, 'opted out')
})
