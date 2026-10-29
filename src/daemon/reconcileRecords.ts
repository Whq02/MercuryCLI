import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { probePidLock } from '../substrate/pidLock.js'
import { logForDebugging } from '../utils/debug.js'
import {
  daemonControlRpc,
  daemonDir,
  readDaemonState,
  daemonStatePath,
} from './controlSocket.js'
import { getProcessStartTokenAsync, isProcessAlive } from './ownerWatch.js'
import { daemonRecordIdentity } from './verbs.js'

interface DaemonRecordsReconcile {

  state: 'live' | 'clean' | 'reconciled'

  cleaned: string[]

  deadPid?: number
  reason: string
}

export async function reconcileDaemonRecords(opts?: {
  projectDir?: string
}): Promise<DaemonRecordsReconcile> {
  const dir = daemonDir()
  const supPath = daemonStatePath()
  const lockPath = join(dir, 'daemon.lock')
  const keyPath = join(dir, 'control.key')

  const sup = await readDaemonState()
  let recordPidRecycled = false
  if (sup && isProcessAlive(sup.pid)) {
    const verdict = daemonRecordIdentity(sup, await getProcessStartTokenAsync(sup.pid))
    if (verdict !== 'not-recorded-process') {
      return { state: 'live', cleaned: [], reason: `daemon pid ${sup.pid} alive` }
    }
    recordPidRecycled = true
  }

  const lockHolder = await probePidLock(lockPath, { liveness: 'assume-alive' })
  if (lockHolder && !(recordPidRecycled && sup !== null && lockHolder.pid === sup.pid)) {
    return {
      state: 'live',
      cleaned: [],
      reason: `daemon.lock held by live pid ${lockHolder.pid}`,
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

  if (!supExists && !lockExists && !keyExists) {
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
  if (supExists) await rm(supPath, 'daemon.json')
  if (lockExists) await rm(lockPath, 'daemon.lock')
  if (keyExists) await rm(keyPath, 'control.key')

  if (cleaned.length === 0) {
    return { state: 'clean', cleaned, reason: 'records vanished before removal (racing reconcile)' }
  }
  const deadPid = sup?.pid
  const reason =
    deadPid != null
      ? recordPidRecycled
        ? `daemon pid ${deadPid} recycled by another process (start-token mismatch) and control socket silent`
        : `daemon pid ${deadPid} not running and control socket silent`
      : 'no live daemon and control socket silent'

  logForDebugging(
    `[daemon-records] reconciled stale daemon records (${reason}): removed ${cleaned.join(', ')}`,
  )
  return { state: 'reconciled', cleaned, ...(deadPid != null ? { deadPid } : {}), reason }
}
