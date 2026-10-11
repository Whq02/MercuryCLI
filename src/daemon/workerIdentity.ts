import { getProcessStartTokenCachedOrRefresh, isProcessAlive } from './ownerWatch.js'

export function workerPidAlive(rec: { pid?: number; procStart?: string }): boolean {
  if (rec.pid === undefined || !isProcessAlive(rec.pid)) return false
  if (rec.procStart !== undefined) {
    const current = getProcessStartTokenCachedOrRefresh(rec.pid)
    if (current === '') return false
    if (current !== null && current !== rec.procStart) return false
  }
  return true
}
