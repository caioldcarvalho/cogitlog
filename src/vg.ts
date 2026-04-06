import fs from 'fs'
import path from 'path'

export const SPEC_VERSION = '0.3'
export const AGENT_TOOL = 'cogitlog-cli'

export function findVibegitDir(startDir = process.cwd()): string | null {
  let dir = startDir
  while (true) {
    const candidate = path.join(dir, '.cogitlog')
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function requireVibegitDir(): string {
  const dir = findVibegitDir()
  if (!dir) {
    console.error('Not a cogitlog repository. Run `cogitlog init` first.')
    process.exit(1)
  }
  return dir
}

export function vgPaths(vgDir: string) {
  return {
    config: path.join(vgDir, 'config.json'),
    index: path.join(vgDir, 'index.jsonl'),
    current: path.join(vgDir, 'current'),
    lock: path.join(vgDir, 'lock'),
    sessions: path.join(vgDir, 'sessions'),
    session: (id: string) => path.join(vgDir, 'sessions', `${id}.jsonl`),
  }
}
