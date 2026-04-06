import { execSync } from 'child_process'
import type { FileRef } from './types'

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

export function getGitRoot(cwd = process.cwd()): string | null {
  const result = run('git rev-parse --show-toplevel', cwd)
  return result || null
}

export function getHead(cwd?: string): string | null {
  const result = run('git rev-parse HEAD', cwd)
  return result.length === 40 ? result : null
}

/** Returns paths of all files with uncommitted changes (staged + unstaged + untracked). */
export function getChangedFiles(cwd?: string): string[] {
  const staged   = run('git diff --name-only --cached', cwd)
  const unstaged = run('git diff --name-only', cwd)
  const newFiles = run('git ls-files --others --exclude-standard', cwd)

  const all = new Set<string>()
  for (const block of [staged, unstaged, newFiles]) {
    for (const line of block.split('\n')) {
      const t = line.trim()
      if (t) all.add(t)
    }
  }
  return Array.from(all)
}

export function isFileDirty(filePath: string, cwd?: string): boolean {
  return run(`git status --porcelain -- "${filePath}"`, cwd).length > 0
}

/** Resolve explicit --file paths into FileRef objects. */
export function resolveFileRefs(filePaths: string[], gitRoot?: string | null): FileRef[] {
  const head = getHead(gitRoot ?? undefined)
  return filePaths.map(p => ({
    path: p,
    base_commit: head,
    dirty: isFileDirty(p, gitRoot ?? undefined),
  }))
}

/** Auto-detect changed files from git and return FileRef objects. Excludes .whygent/ internals. */
export function autoFileRefs(gitRoot?: string | null): FileRef[] {
  const head = getHead(gitRoot ?? undefined)
  return getChangedFiles(gitRoot ?? undefined)
    .filter(p => !p.startsWith('.whygent/'))
    .map(p => ({
      path: p,
      base_commit: head,
      dirty: true,
    }))
}
