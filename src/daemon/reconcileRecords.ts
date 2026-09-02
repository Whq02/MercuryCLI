
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { probePidLock } from '../substrate/pidLock.js'
import { logForDebugging } from '../utils/debug.js'
import {
  daemonControlRpc,
  daemonDir,
  readSupervisorState,
  supervisorStatePath,
} from './controlSocket.js'
import { getProcessStartTokenAsync, isProcessAlive } from './ownerWatch.js'
import { supervisorRecordIdentity } from './verbs.js'

export interface DaemonRecordsReconcile {
  state: 'live' | 'clean' | 'reconciled'
  cleaned: string[]
  deadPid?: number
  reason: string
}

export async function reconcileDaemonRecords(opts?: {
  projectDir?: string
}): Promise<DaemonRecordsReconcile> {
  const dir = daemonDir()
  const supPath = supervisorStatePath()
  const lockPath = join(dir, 'supervisor.lock')
  const keyPath = join(dir, 'control.key')

  const sup = await readSupervisorState()
  let recordPidRecycled = false
  if (sup && isProcessAlive(sup.pid)) {
    const verdict = supervisorRecordIdentity(sup, await getProcessStartTokenAsync(sup.pid))
    if (verdict !== 'not-recorded-process') {
      return { state: 'live', cleaned: [], reason: `supervisor pid ${sup.pid} alive` }
    }
    recordPidRecycled = true
  }
  const lockHolder = await probePidLock(lockPath, { liveness: 'assume-alive' })
  if (lockHolder && !(recordPidRecycled && sup !== null && lockHolder.pid === sup.pid)) {
    return {
      state: 'live',
      cleaned: [],
      reason: `supervisor.lock held by live pid ${lockHolder.pid}`,
    }
  }

  const supExists = existsSync(supPath)
  const lockExists = existsSync(lockPath)
  const keyExists = existsSync(keyPath)

  if (supExists || lockExists || keyExists) {
    const pong = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 900 }).catch(() => null)
    if (pong && pong.ok === true) {
      return { state: 'live', cleaned: [], reason: 'control socket answered ping' }
    }
  }

  const schedulerCleaned: string | null = null

  if (!supExists && !lockExists && !keyExists) {
    if (schedulerCleaned) {
      const reason = 'stale scheduler lock (dead holder)'
      logForDebugging(
        `[daemon-records] reconciled stale daemon records (${reason}): removed ${schedulerCleaned}`,
      )
      return { state: 'reconciled', cleaned: [schedulerCleaned], reason }
    }
    return { state: 'clean', cleaned: [], reason: 'no daemon records on disk' }
  }

  const cleaned: string[] = []
  const rm = async (path: string, name: string): Promise<void> => {
    try {
      await unlink(path)
      cleaned.push(name)
    } catch {
    }
  }
  if (supExists) await rm(supPath, 'supervisor.json')
  if (lockExists) await rm(lockPath, 'supervisor.lock')
  if (keyExists) await rm(keyPath, 'control.key')
  if (schedulerCleaned) cleaned.push(schedulerCleaned)

  if (cleaned.length === 0) {
    return { state: 'clean', cleaned, reason: 'records vanished before removal (racing reconcile)' }
  }
  const deadPid = sup?.pid
  const reason =
    deadPid != null
      ? recordPidRecycled
        ? `supervisor pid ${deadPid} recycled by another process (start-token mismatch) and control socket silent`
        : `supervisor pid ${deadPid} not running and control socket silent`
      : 'no live supervisor and control socket silent'
  logForDebugging(
    `[daemon-records] reconciled stale daemon records (${reason}): removed ${cleaned.join(', ')}`,
  )
  return { state: 'reconciled', cleaned, ...(deadPid != null ? { deadPid } : {}), reason }
}
