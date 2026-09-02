import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import { getAutoMemPath } from '../../memdir/paths.js'

/**
 * Single-file consolidation lock whose mtime doubles as "last consolidated
 * at"; the body is the holder's process id. The file lives inside the memory
 * directory so it keys on the git root the way memory does, and is writable
 * even when the memory path comes from an override whose parent is not.
 */

const LOCK_STALENESS_MS = 60 * 60 * 1000

function lockPath(): string {
  return join(getAutoMemPath(), '.consolidation.lock')
}

/** The lock file's mtime, or 0 on any failure. */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const info = await stat(lockPath())
    return info.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Acquire the lock, or return null. A dead pid or an unparseable body is
 * reclaimable, as is any lock older than the 1-hour staleness bound even
 * with a live pid (a process-id reuse guard). On success returns the
 * pre-acquire mtime (0 when the file did not exist) for rollback.
 */
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
    // No lock file yet — freely acquirable.
  }

  // A fresh-looking lock blocks ONLY when its holder pid is recorded AND
  // still running; a dead holder's fresh lock never blocks consolidation.
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
    // Re-read: if the file no longer holds this process's pid, another
    // reclaimer won the race.
    const check = await readFile(path, 'utf8')
    if (check.trim() !== String(process.pid)) return null
  } catch {
    return null
  }
  return priorMtime
}

/** Does the lock body still name `pid`? A missing file is nobody's; an
 *  unparseable body is treated as ours (the pre-pid shape). Exported for the
 *  parity prover. */
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

/**
 * Rollback after a failed run. A prior mtime of 0 unlinks the file
 * (restoring "no file"); otherwise the body is blanked — this still-running
 * process must not look like the holder — and the mtime is rewound.
 */
export async function rollbackConsolidationLock(priorMtime: number): Promise<void> {
  const path = lockPath()
  try {
    // Ownership first: a run that outlived the staleness bound may have been
    // reclaimed by another process, whose live pid now fills the body. Rolling
    // back over it would delete or blank a lock that is not ours
    // (sweep #2 item 73); the successor's run owns the rollback now.
    if (!(await consolidationLockHeldBy(path, process.pid))) {
      logForDebugging('consolidationLock: rollback skipped — another process reclaimed the lock')
      return
    }
    if (priorMtime === 0) {
      await unlink(path)
      return
    }
    await writeFile(path, '')
    // utimes takes seconds; the stored value is milliseconds.
    const seconds = priorMtime / 1000
    await utimes(path, seconds, seconds)
  } catch {
    logForDebugging(
      'consolidationLock: rollback failed; the next trigger is delayed to the minimum-hours gate',
    )
  }
}

/**
 * Manual stamp, called optimistically at prompt-build time when the operator
 * runs the manual consolidation command (there is no post-completion hook).
 * Best-effort.
 */
export async function recordConsolidation(): Promise<void> {
  try {
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(lockPath(), String(process.pid))
  } catch {
    logForDebugging('consolidationLock: manual stamp failed')
  }
}

/**
 * Session transcripts for the current project directory touched since the
 * cutoff (by mtime — birth time is unavailable on some filesystems). Scans
 * per-working-directory transcripts only; as a skip gate, undercounting
 * worktree sessions is safe. Does NOT exclude the current session — the
 * caller does, because its transcript is always freshly touched.
 */
export async function listSessionsTouchedSince(sinceMs: number): Promise<string[]> {
  const sessions = await listSessionsImpl({ dir: getCwd(), limit: 0, includeWorktrees: false })
  return sessions.filter(session => session.lastModified > sinceMs).map(session => session.sessionId)
}
