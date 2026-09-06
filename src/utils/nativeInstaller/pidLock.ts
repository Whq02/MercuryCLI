import { readdirSync, readFileSync, lstatSync, rmSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { logForDebugging } from '../debug.js'
import { getProcessCommand } from '../genericProcessUtils.js'
import { logError } from '../log.js'


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

export function isPidBasedLockingEnabled(): boolean {
  try {
    return getFeatureValue_CACHED_MAY_BE_STALE<boolean>('mercury_pid_based_version_locking', false) === true
  } catch {
    return false
  }
}

export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

const MTIME_RECONFIRM_THRESHOLD_MS = 2 * 60 * 60 * 1000

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
  }
  return true
}

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
    }
  }
  return cleaned
}
