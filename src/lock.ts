import fs from 'fs'

const RETRY_DELAY_MS = 50
const MAX_RETRIES = 100

export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  await acquire(lockPath, 0)
  try {
    return await fn()
  } finally {
    try { fs.unlinkSync(lockPath) } catch { /* already gone */ }
  }
}

async function acquire(lockPath: string, retries: number): Promise<void> {
  if (retries >= MAX_RETRIES) {
    throw new Error(`Could not acquire cogitlog lock after ${MAX_RETRIES} retries: ${lockPath}`)
  }

  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err
  }

  // Lock exists — check if holder is alive
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim()
    const pid = parseInt(raw, 10)
    if (!isNaN(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0) // throws if dead
      } catch {
        fs.unlinkSync(lockPath) // stale lock
        return acquire(lockPath, retries)
      }
    }
  } catch { /* file disappeared between checks */ }

  await sleep(RETRY_DELAY_MS)
  return acquire(lockPath, retries + 1)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
