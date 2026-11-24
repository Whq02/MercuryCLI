import { getProcessStartTokenCachedOrRefresh, isProcessAlive, refreshProcessStartTokens } from '../control/ownerWatch.js'
import { tokenBinding } from '../process-sweep/processSweep.js'

export function askWorkerPidStarts(recs: readonly { pid?: number; procStart?: string }[]): void {
  refreshProcessStartTokens(
    recs.flatMap(rec => (rec.pid !== undefined && rec.procStart !== undefined && isProcessAlive(rec.pid) ? [{ pid: rec.pid, procStart: rec.procStart }] : [])),
  )
}

export function workerPidAlive(rec: { pid?: number; procStart?: string }): boolean {
  if (rec.pid === undefined || !isProcessAlive(rec.pid)) return false
  if (rec.procStart !== undefined) {
    const current = getProcessStartTokenCachedOrRefresh(rec.pid, undefined, rec.procStart)
    if (current === '') return false
    if (current !== null && tokenBinding(rec.procStart, current) === 'stranger') return false
  }
  return true
}
