import type { ConcourseRowV1 } from '../../components/concourse/contracts.js'
import { workerPidAlive } from '../workerIdentity.js'
import { readSessionWorkers } from './store.js'
import type { ConcourseWorkerRecordV1 } from './record.js'

export function sessionOwnedByLiveWorker(sessionId: string, dir?: string): string | null {
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt !== undefined) continue
    if (rec.sessionId !== sessionId) continue
    if (rec.attachedAt !== undefined) return rec.runnerId
    if (workerPidAlive(rec)) return rec.runnerId
  }
  return null
}

export function boardHomedSessionIds(dir?: string): Set<string> {
  const out = new Set<string>()
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt === undefined && rec.parkedAt === undefined) out.add(rec.sessionId)
  }
  return out
}

export function countLiveConcourseWorkers(dir?: string): number {
  let n = 0
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt === undefined && workerPidAlive(rec)) n++
  }
  return n
}

export function concourseRecordState(
  rec: Pick<ConcourseWorkerRecordV1, 'pausedAt' | 'lastDeliveryAt' | 'lastTurnSettledAt' | 'attachedAt' | 'stoppedAt' | 'crash' | 'parkedAt' | 'bornBlankAt' | 'resumedAtRestAt' | 'pid'>,
  liveness: { needsYou: boolean; alive: boolean },
): ConcourseRowV1['state'] {
  const turnSettled =
    rec.lastTurnSettledAt !== undefined &&
    (rec.lastDeliveryAt === undefined || rec.lastTurnSettledAt >= rec.lastDeliveryAt)
  const admittedAtRest = (rec.bornBlankAt !== undefined || rec.resumedAtRestAt !== undefined) && rec.lastDeliveryAt === undefined
  return rec.attachedAt !== undefined
    ? 'attached'
    : rec.parkedAt !== undefined
      ? 'parked'
      : rec.stoppedAt !== undefined
        ? 'stopped'
        : rec.pausedAt !== undefined
          ? 'paused'
          : rec.crash !== undefined
            ? 'needs-you'
            : liveness.needsYou
              ? 'needs-you'
              : liveness.alive
                ? turnSettled || admittedAtRest
                  ? 'ready-to-review'
                  : 'working'
                : rec.pid !== undefined
                  ? 'needs-you'
                  : 'starting'
}
