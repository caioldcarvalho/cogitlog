import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'

const CLI = path.resolve(__dirname, '..', 'src', 'cli.ts')
// --import resolves from the cwd, and the cwd here is a temp repo: pin the loader.
const TSX = require.resolve('tsx')

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cogitlog-hooks-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function cli(cwd: string, args: string[], input = ''): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd, input, encoding: 'utf8',
    env: { ...process.env, COGITLOG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' },
  })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

test('agent-begin takes the intent from the prompt field Claude Code sends', () => {
  const dir = repo()
  cli(dir, ['init'])
  cli(dir, ['hook', 'agent-begin'], JSON.stringify({ prompt: 'make the parser faster' }))
  const index = fs.readFileSync(path.join(dir, '.cogitlog', 'index.jsonl'), 'utf8')
  assert.match(index, /make the parser faster/)
})

test('agent-pre-tool matches absolute paths and answers in the PreToolUse JSON shape', () => {
  const dir = repo()
  cli(dir, ['init'])
  cli(dir, ['begin', 'pick a db'])
  cli(dir, ['decision', 'sqlite: one file', '-f', 'src/db.ts'])
  cli(dir, ['close', '--outcome', 'completed'])
  const r = cli(dir, ['hook', 'agent-pre-tool'], JSON.stringify({ tool_input: { file_path: path.join(dir, 'src', 'db.ts') } }))
  const out = JSON.parse(r.stdout.trim().split('\n').pop() as string)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.match(out.hookSpecificOutput.additionalContext, /sqlite: one file/)
})

test('agent-pre-tool stays silent for files outside the repo', () => {
  const dir = repo()
  cli(dir, ['init'])
  const r = cli(dir, ['hook', 'agent-pre-tool'], JSON.stringify({ tool_input: { file_path: '/etc/hosts' } }))
  assert.equal(r.stdout.trim(), '')
})
