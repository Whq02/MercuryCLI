import { askWorkerPidStarts, workerPidAlive } from './workerIdentity.js'
import { readSessionWorkers } from './store.js'

export { concourseRecordState } from './recordState.js'

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
  const unended = Object.values(readSessionWorkers(dir)).filter(rec => rec.endedAt === undefined)
  askWorkerPidStarts(unended)
  let n = 0
  for (const rec of unended) {
    if (workerPidAlive(rec)) n++
  }
  return n
}
