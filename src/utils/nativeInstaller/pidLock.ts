import { readdirSync, readFileSync, lstatSync, rmSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { logForDebugging } from '../debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getProcessCommand } from '../genericProcessUtils.js'
import { logError } from '../log.js'

/**
 * PID-based version locks: staleness is process liveness, not file age, so
 * a crash releases the lock immediately. In this build locks are only
 * LISTED and CLEANED (the doctor report); nothing acquires them.
 */

export type VersionLockContent = {
  pid: number
  version: string
  execPath: string
  acquiredAt: number
}

export type LockInfo = {
  version: string
  pid: number
  isRunning: boolean
  execPath: string
  acquiredAt: Date
  lockFilePath: string
}

/** Truthy env forces on; defined-falsy forces off; otherwise the gate decides (default false). */
export function isPidBasedLockingEnabled(): boolean {
  const envValue = process.env.ENABLE_PID_BASED_VERSION_LOCKING
  if (isEnvTruthy(envValue)) return true
  if (isEnvDefinedFalsy(envValue)) return false
  try {
    return getFeatureValue_CACHED_MAY_BE_STALE<boolean>('mercury_pid_based_version_locking', false) === true
  } catch {
    return false
  }
}

/**
 * Signal-0 liveness. Pids at or below 1 are NEVER running: 0 refers to the
 * process group and 1 is init — neither should ever hold a lock.
 */
export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Pid-reuse mitigation, conservative in one direction: a pid belongs to
 * this product when it is running and is this very process, or its command
 * line could not be read (better to keep a lock than delete a running
 * version's), or the lowercased command names the product or the expected
 * executable path.
 */
function isPidOwnedByProduct(pid: number, expectedExecPath: string): boolean {
  if (!isProcessRunning(pid)) return false
  if (pid === process.pid) return true
  try {
    const command = getProcessCommand(pid)
    if (command === null) return true
    const lowered = command.toLowerCase()
    return lowered.includes('claude') || lowered.includes(expectedExecPath.toLowerCase())
  } catch {
    return true
  }
}

/** Null for a missing/empty/unparseable file, a non-numeric pid, or a falsy version or execPath. */
export function readLockContent(lockFilePath: string): VersionLockContent | null {
  try {
    const raw = readFileSync(lockFilePath, 'utf8')
    if (raw.trim() === '') return null
    const parsed = JSON.parse(raw) as Partial<VersionLockContent>
    if (typeof parsed.pid !== 'number') return null
    if (!parsed.version || !parsed.execPath) return null
    return parsed as VersionLockContent
  } catch {
    return null
  }
}

// Guards network-filesystem edge cases; a no-op in the common case.
const MTIME_RECONFIRM_THRESHOLD_MS = 2 * 60 * 60 * 1000

/** Readable content AND a running pid AND product ownership; a running non-product pid is logged and treated as stale. */
export function isLockActive(lockFilePath: string): boolean {
  const content = readLockContent(lockFilePath)
  if (content === null) return false
  if (!isProcessRunning(content.pid)) return false
  if (!isPidOwnedByProduct(content.pid, content.execPath)) {
    logForDebugging(`version lock ${lockFilePath} held by non-product pid ${content.pid}; treating as stale`)
    return false
  }
  try {
    const fileStat = statSync(lockFilePath)
    if (Date.now() - fileStat.mtimeMs > MTIME_RECONFIRM_THRESHOLD_MS) {
      return isProcessRunning(content.pid)
    }
  } catch {
    // A stat failure trusts the pid check.
  }
  return true
}

/** One record per parseable `.lock` entry; a missing directory is an empty list. */
export function getAllLockInfo(locksDir: string): LockInfo[] {
  const locks: LockInfo[] = []
  let entries: string[]
  try {
    entries = readdirSync(locksDir)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    logError(error)
    return locks
  }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue
    const lockFilePath = join(locksDir, entry)
    const content = readLockContent(lockFilePath)
    if (content === null) continue
    locks.push({
      version: content.version,
      pid: content.pid,
      isRunning: isProcessRunning(content.pid),
      execPath: content.execPath,
      acquiredAt: new Date(content.acquiredAt),
      lockFilePath,
    })
  }
  return locks
}

/**
 * Removes stale locks and legacy directory locks (from the old mtime-based
 * mechanism). Deliberately applies NO enablement gate of its own — whether
 * PID locking is in force is the caller's decision. Entries are stat'ed
 * without following symlinks; per-entry errors are ignored.
 */
export function cleanupStaleLocks(locksDir: string): number {
  let cleaned = 0
  let entries: string[]
  try {
    entries = readdirSync(locksDir)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 0
    logError(error)
    return cleaned
  }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue
    const lockPath = join(locksDir, entry)
    try {
      const entryStat = lstatSync(lockPath)
      if (entryStat.isDirectory()) {
        rmSync(lockPath, { recursive: true, force: true })
        logForDebugging(`removed legacy directory lock ${lockPath}`)
        cleaned++
        continue
      }
      if (!isLockActive(lockPath)) {
        unlinkSync(lockPath)
        logForDebugging(`removed stale version lock ${lockPath}`)
        cleaned++
      }
    } catch {
      // Per-entry errors are ignored.
    }
  }
  return cleaned
}
