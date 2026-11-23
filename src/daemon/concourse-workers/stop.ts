import { workerPidAlive } from './workerIdentity.js'
import { updateConcourseWorkers, readSessionWorkers } from './store.js'
import { stampStopped, type ConcourseWorkerRecordV1 } from './record.js'

export type ConcourseStopOutcome =
  | {
      outcome: 'applied'
      runnerId: string
      acknowledged: boolean
    }
  | { outcome: 'noop'; reason: 'already-stopped' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'no-kill-channel'; detail?: string }

export function stopConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  retired?: ConcourseWorkerRecordV1['retired'],
): ConcourseStopOutcome {
  let out: ConcourseStopOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.stoppedAt !== undefined || rec.parkedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-stopped' }
      return
    }
    if (workerPidAlive(rec)) {
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — record left live`,
        }
        return
      }
      if (rec.stopRequestedAt === undefined) {
        rec.stopRequestedAt = Date.now()
        rec.stopRequestedBy = by
        rec.turnCutAt = rec.stopRequestedAt
        rec.turnCutBy = by
        if (retired !== undefined) rec.stopRequestedRetired = retired
      }
      out = { outcome: 'applied', runnerId: rec.runnerId, acknowledged: false }
      return
    }
    roster?.kill(rec.runnerId)
    stampStopped(rec, by, retired)
    out = { outcome: 'applied', runnerId: rec.runnerId, acknowledged: true }
  }, dir)
  return out
}

export function completeRequestedStop(runnerId: string, dir?: string): boolean {
  const standing = readSessionWorkers(dir)[runnerId]
  if (!standing || standing.endedAt !== undefined || standing.stoppedAt !== undefined || standing.stopRequestedAt === undefined) return false
  let completed = false
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec || rec.endedAt !== undefined || rec.stoppedAt !== undefined || rec.stopRequestedAt === undefined) return
    if (workerPidAlive(rec)) return
    stampStopped(rec, rec.stopRequestedBy ?? 'daemon', rec.stopRequestedRetired)
    completed = true
  }, dir)
  return completed
}
