import { getProcessStartTokenCachedOrRefresh, isProcessAlive } from './ownerWatch.js'
import { tokenBinding } from './processSweep.js'

export function workerPidAlive(rec: { pid?: number; procStart?: string }): boolean {
  if (rec.pid === undefined || !isProcessAlive(rec.pid)) return false
  if (rec.procStart !== undefined) {
    const current = getProcessStartTokenCachedOrRefresh(rec.pid, undefined, rec.procStart)
    if (current === '') return false
    if (current !== null && tokenBinding(rec.procStart, current) === 'stranger') return false
  }
  return true
}
