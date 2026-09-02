/**
 * reconcileRecords — boot-time reconcile for a TERMINATED supervisor's on-disk
 * records.
 *
 * On win32 a TerminateProcess'd daemon fires NO signal and NO 'exit' event, so
 * supervisor.json, supervisor.lock, control.key and the project's
 * scheduled_tasks.lock survive as stale debris. Field-proven that nothing
 * reconciles them organically: 19 clean 1.5.2 headless runs left the records
 * byte-identical — session boots never looked, and the locks self-heal only on
 * the next ACQUIRE (which never comes on a session-only home). This pass runs
 * from the boot-recovery orchestrator (session + daemon scope) and the doctor's
 * daemon row (verb-path cleanup), so the next successful run of ANY of them
 * reconciles all four artifacts with ONE receipt line.
 *
 * Conservative by construction (G13 — PID-reuse conservative):
 *   - a live supervisor.json pid           ⇒ hands off everything;
 *   - a live supervisor.lock holder        ⇒ hands off (the mid-boot window:
 *     the lock is acquired BEFORE the state record is written);
 *   - a control-socket pong                ⇒ hands off (the authoritative
 *     serving probe, whatever the records look like);
 *   - the scheduler lock is judged by ITS OWN holder (a REPL session may own
 *     it legitimately while no daemon exists), via probePidLock's confirmed
 *     take-aside — never a raw unlink of a parseable record;
 *   - daemon.log is NEVER touched: logs are records, not lock debris (G14).
 *
 * Like the rest of the substrate IO, this never throws — every removal is
 * best-effort and the typed report says what actually happened.
 */

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
  /** live: a liveness signal stopped the pass; clean: nothing to do;
   *  reconciled: stale records were removed (see `cleaned`). */
  state: 'live' | 'clean' | 'reconciled'
  /** Basenames actually removed this pass. */
  cleaned: string[]
  /** The dead supervisor pid the records pointed at, when known. */
  deadPid?: number
  reason: string
}

/**
 * Reconcile stale daemon records for this config home (+ the given project's
 * scheduler lock). The scheduler-lock leg runs ONLY when `projectDir` is
 * declared (the daemon passes its scheduling dir, the REPL boot its project
 * root) — callers without a declared project (doctor's daemon row, bare
 * utility calls) reconcile the daemon-dir trio alone.
 */
export async function reconcileDaemonRecords(opts?: {
  projectDir?: string
}): Promise<DaemonRecordsReconcile> {
  const dir = daemonDir()
  const supPath = supervisorStatePath()
  const lockPath = join(dir, 'supervisor.lock')
  const keyPath = join(dir, 'control.key')

  // G13: any liveness signal ⇒ untouched. The state record's pid first —
  // judged by IDENTITY, not by pid-liveness alone: on a fast-recycling box
  // (the win32 field reality) a dead daemon's pid is soon a stranger's, and
  // the bare kill(pid,0) read kept the stale trio alive through every boot
  // (TASK-017 F-1's A/B: clearing the two files healed the next boot). The
  // ONE identity owner (verbs.supervisorRecordIdentity — the D-convergence
  // union): byte-equal against the record's own startToken where one
  // exists, the birth-time fallback for a pre-token record; an unknown
  // (probe glitch, unreadable token) reads conservatively live.
  const sup = await readSupervisorState()
  let recordPidRecycled = false
  if (sup && isProcessAlive(sup.pid)) {
    const verdict = supervisorRecordIdentity(sup, await getProcessStartTokenAsync(sup.pid))
    if (verdict !== 'not-recorded-process') {
      return { state: 'live', cleaned: [], reason: `supervisor pid ${sup.pid} alive` }
    }
    recordPidRecycled = true
  }
  // …then the supervisor lock's holder (assume-alive polarity: an ambiguous
  // probe reads live and stops the pass — never steal from a safety gate).
  // The identity verdict extends to the lock exactly when it names the pid
  // the token just disproved: the daemon acquires its own lock, so a
  // recycled supervisor pid would otherwise read as a live holder and veto
  // the sweep of records the token proved orphaned. A holder naming any
  // OTHER pid keeps the conservative hand-off whole.
  const lockHolder = await probePidLock(lockPath, { liveness: 'assume-alive' })
  if (lockHolder && !(recordPidRecycled && sup !== null && lockHolder.pid === sup.pid)) {
    return {
      state: 'live',
      cleaned: [],
      reason: `supervisor.lock held by live pid ${lockHolder.pid}`,
    }
  }

  const supExists = existsSync(supPath) // unparseable records still count as debris
  const lockExists = existsSync(lockPath)
  const keyExists = existsSync(keyPath)

  // Authoritative dead-confirm BEFORE any removal: a SERVING daemon answers
  // the pre-auth ping whatever its records look like (the
  // clearDeadSupervisorRecords contract). Only needed when daemon-side records
  // exist — with none on disk no daemon can be serving this home. No socket ⇒
  // one failed connect attempt, no waiting.
  if (supExists || lockExists || keyExists) {
    const pong = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 900 }).catch(() => null)
    if (pong && pong.ok === true) {
      return { state: 'live', cleaned: [], reason: 'control socket answered ping' }
    }
  }

  // (The old per-project scheduler lock died with its engine — SATURN's
  // schedules ride the session records and hold no project lock. A stale
  // legacy lock file on an old box is inert debris; nothing reads it.)
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
      /* absent or racing a sibling reconcile — fine */
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
  // ONE receipt (G12): a single line names every artifact this pass removed.
  logForDebugging(
    `[daemon-records] reconciled stale daemon records (${reason}): removed ${cleaned.join(', ')}`,
  )
  return { state: 'reconciled', cleaned, ...(deadPid != null ? { deadPid } : {}), reason }
}
