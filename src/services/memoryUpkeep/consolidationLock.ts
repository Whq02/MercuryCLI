import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import { getAutoMemPath } from '../../memdir/paths.js'


const LOCK_STALENESS_MS = 60 * 60 * 1000

function lockPath(): string {
  return join(getAutoMemPath(), '.consolidation.lock')
}

export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const info = await stat(lockPath())
    return info.mtimeMs
  } catch {
    return 0
  }
}

export async function tryAcquireConsolidationLock(): Promise<number | null> {
  const path = lockPath()
  let priorMtime = 0
  let holderPid: number | null = null
  try {
    const [info, body] = await Promise.all([stat(path), readFile(path, 'utf8')])
    priorMtime = info.mtimeMs
    const parsed = Number.parseInt(body.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : null
  } catch {
  }

  const age = Date.now() - priorMtime
  if (priorMtime > 0 && age < LOCK_STALENESS_MS && holderPid !== null && isProcessRunning(holderPid)) {
    logForDebugging(
      `consolidationLock: held by live pid ${holderPid} (age ${Math.round(age / 1000)}s); refusing`,
    )
    return null
  }

  try {
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(path, String(process.pid))
    const check = await readFile(path, 'utf8')
    if (check.trim() !== String(process.pid)) return null
  } catch {
    return null
  }
  return priorMtime
}

export async function consolidationLockHeldBy(path: string, pid: number): Promise<boolean> {
  let body: string
  try {
    body = await readFile(path, 'utf8')
  } catch {
    return false
  }
  const parsed = Number.parseInt(body.trim(), 10)
  return !Number.isFinite(parsed) || parsed === pid
}

export async function rollbackConsolidationLock(priorMtime: number): Promise<void> {
  const path = lockPath()
  try {
    if (!(await consolidationLockHeldBy(path, process.pid))) {
      logForDebugging('consolidationLock: rollback skipped — another process reclaimed the lock')
      return
    }
    if (priorMtime === 0) {
      await unlink(path)
      return
    }
    await writeFile(path, '')
    const seconds = priorMtime / 1000
    await utimes(path, seconds, seconds)
  } catch {
    logForDebugging(
      'consolidationLock: rollback failed; the next trigger is delayed to the minimum-hours gate',
    )
  }
}

export async function recordConsolidation(): Promise<void> {
  try {
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(lockPath(), String(process.pid))
  } catch {
    logForDebugging('consolidationLock: manual stamp failed')
  }
}

export async function listSessionsTouchedSince(sinceMs: number): Promise<string[]> {
  const sessions = await listSessionsImpl({ dir: getCwd(), limit: 0, includeWorktrees: false })
  return sessions.filter(session => session.lastModified > sinceMs).map(session => session.sessionId)
}
