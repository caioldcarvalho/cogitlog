import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { findVibegitDir, vgPaths } from './vg'

/**
 * Update notices, modelled on what npm and codex do.
 *
 * Two rules make this safe to run on every invocation:
 *
 *  1. **Never block.** The check itself happens in a detached child process; the
 *     command you actually ran does not wait on the network, ever. The notice you
 *     see comes from a cache written by an earlier run.
 *  2. **Never touch stdout.** Notices go to stderr, because `query --json` and the
 *     MCP server parse stdout, and a stray line there corrupts the output.
 */

const REGISTRY = 'https://registry.npmjs.org/cogitlog/latest'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000

/** Hidden subcommand the detached child runs. Also the recursion guard. */
export const REFRESH_COMMAND = '__update-check'

interface Cache {
  checked_at: string
  latest: string | null
}

function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  return path.join(base, 'cogitlog', 'update-check.json')
}

function readCache(): Cache | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Cache
  } catch {
    return null
  }
}

/** Numeric major.minor.patch comparison. Prerelease tags are ignored — the registry's
 *  `latest` tag never points at one. */
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const [a, b] = [parse(latest), parse(current)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

function isDisabled(): boolean {
  if (process.env.COGITLOG_NO_UPDATE_CHECK) return true
  // CI runs are ephemeral: the notice helps nobody and pollutes build logs.
  if (process.env.CI) return true

  const vgDir = findVibegitDir()
  if (vgDir) {
    try {
      const config = JSON.parse(fs.readFileSync(vgPaths(vgDir).config, 'utf8'))
      if (config.update_check === false) return true
    } catch { /* no config, or unreadable — not a reason to stay quiet */ }
  }
  return false
}

/** Fetch the registry and write the cache. Runs in the detached child. */
export async function refreshCache(): Promise<void> {
  let latest: string | null = null
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.ok) latest = ((await res.json()) as { version?: string }).version ?? null
  } catch { /* offline, rate-limited, whatever — recorded as a miss below */ }

  const file = cacheFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Written even when the fetch failed, so a machine with no network retries once
  // a day instead of spawning a child on every single command.
  fs.writeFileSync(file, JSON.stringify({ checked_at: new Date().toISOString(), latest }), 'utf8')
}

function spawnRefresh(): void {
  try {
    const child = spawn(process.execPath, [process.argv[1], REFRESH_COMMAND], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, COGITLOG_NO_UPDATE_CHECK: '1' },
    })
    child.unref()
  } catch { /* spawning is best-effort; a failed check must never surface */ }
}

/**
 * Kick off a refresh when the cache is stale. Call this at startup: spawning is
 * synchronous and the child is unref'd, so the current command neither waits for
 * the network nor keeps the process alive.
 */
export function scheduleUpdateCheck(): void {
  if (isDisabled()) return
  try {
    const cache = readCache()
    const age = cache ? Date.now() - new Date(cache.checked_at).getTime() : Infinity
    if (!(age < MAX_AGE_MS)) spawnRefresh()
  } catch { /* a version check is never worth failing a command over */ }
}

/**
 * Print the notice, if the last refresh found something newer. Call this on exit
 * so it lands after the command's own output rather than on top of it.
 */
export function printUpdateNotice(current: string): void {
  if (isDisabled()) return
  try {
    const cache = readCache()
    if (!cache?.latest || !isNewer(cache.latest, current)) return
    console.error(
      `\ncogitlog ${cache.latest} is available (you have ${current}) — npm i -g cogitlog\n` +
      `  silence with COGITLOG_NO_UPDATE_CHECK=1, or "update_check": false in .cogitlog/config.json`,
    )
  } catch { /* same */ }
}
