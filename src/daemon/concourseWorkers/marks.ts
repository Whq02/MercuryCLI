import { getProcessStartInstant, getProcessStartInstantCachedOrRefresh } from '../ownerWatch.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { runningBuildTree } from '../../utils/artifactIdentity.js'
import { readSessionWorkers, updateConcourseWorkers } from './store.js'
import { sessionActivityOf } from './record.js'

export function markConcourseWorkerActivity(
  runnerId: string,
  input: { turnActive: boolean; work?: readonly WorkRowV1[]; waitingOnAgents?: number; lastTurnAt?: number },
  dir?: string,
): void {
  const current = readSessionWorkers(dir)[runnerId]
  if (!current || current.endedAt !== undefined) return
  const activity = sessionActivityOf(input.turnActive, input.work, input.waitingOnAgents ?? 0, input.lastTurnAt ?? current.activity?.lastTurnAt ?? null)
  if (JSON.stringify(current.activity) === JSON.stringify(activity)) return
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) rec.activity = activity
    }, dir)
  } catch {}
}

export function markConcourseWorkerDelivery(runnerId: string, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.lastDeliveryAt = Date.now()
        rec.activity = { state: 'working', subagents: rec.activity?.subagents ?? 0, description: 'working', lastTurnAt: rec.activity?.lastTurnAt ?? null }
        delete rec.crash
        delete rec.parkRefused
        if (rec.contract !== undefined && rec.contract.status === 'acknowledged') {
          rec.contract.status = 'active'
        }
      }
    }, dir)
  } catch {
  }
}

export function markConcourseWorkerTurnSettled(runnerId: string, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.lastTurnSettledAt = Date.now()
        const count = rec.activity?.subagents ?? 0
        rec.activity = sessionActivityOf(false, undefined, count, rec.lastTurnSettledAt)
      }
    }, dir)
  } catch {
  }
}

export function markConcourseWorkerCrash(
  runnerId: string,
  crash: { reason: string; respawning: boolean },
  dir?: string,
): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.crash = { at: Date.now(), reason: crash.reason, respawning: crash.respawning }
        delete rec.restartReason
      }
    }, dir)
  } catch {
  }
}

export function pidFieldsOf(pid: number | undefined, startToken = pid === undefined ? null : getProcessStartInstant(pid)): { pid?: number; procStart?: string } {
  if (pid === undefined) return {}
  const token = startToken ?? getProcessStartInstantCachedOrRefresh(pid)
  return { pid, ...(token !== null && token !== '' ? { procStart: token } : {}) }
}

export function buildTreeFields(): { buildTree?: string } {
  const tree = runningBuildTree()
  return tree !== null ? { buildTree: tree } : {}
}

export function markConcourseWorkerRespawn(runnerId: string, pid: number, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.pid = pid
        const fields = pidFieldsOf(pid)
        if (fields.procStart !== undefined) rec.procStart = fields.procStart
        else delete rec.procStart
        rec.lastLiveAt = Date.now()
      }
    }, dir)
  } catch {
  }
}
