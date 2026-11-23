import type { ConcourseRowV1 } from '../../screen/concourse/contracts.js'
import type { ConcourseWorkerRecordV1 } from './record.js'

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
