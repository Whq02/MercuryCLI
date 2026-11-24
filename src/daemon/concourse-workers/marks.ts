import { getProcessStartInstant, getProcessStartInstantAsync, getProcessStartInstantCachedOrRefresh } from '../control/ownerWatch.js'
import type { WorkRowV1 } from '../../engine/connector/types.js'
import { runningBuildTree } from '../../platform/product/artifactIdentity.js'
import { readSessionWorkers, rememberUnstampedRunnerPid, updateConcourseWorkers } from './store.js'
import { sessionActivityOf } from './record.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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
  } catch (error) { passedOver(error) }
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
      }
    }, dir)
  } catch (err) {
    console.error(`[daemon] ${runnerId}: the delivery was not stamped on its session record: ${errorMessage(err)}`)
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
  } catch (err) {
    console.error(`[daemon] ${runnerId}: the settled turn was not stamped on its session record, it reads as working until a later turn settles: ${errorMessage(err)}`)
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
  } catch (err) {
    console.error(`[daemon] ${runnerId}: the crash was not stamped on its session record, the board does not show it: ${errorMessage(err)}`)
  }
}

export function pidFieldsOf(pid: number | undefined, startToken = pid === undefined ? null : getProcessStartInstant(pid)): { pid?: number; procStart?: string } {
  if (pid === undefined) return {}
  const token = startToken ?? getProcessStartInstantCachedOrRefresh(pid)
  return { pid, ...(token !== null && token !== '' ? { procStart: token } : {}) }
}

export async function claimedPidFields(claimed: { pid?: number; startInstant?: Promise<string | null> }): Promise<{ pid?: number; procStart?: string }> {
  if (claimed.pid === undefined) return {}
  const atSpawn = await claimed.startInstant
  return pidFieldsOf(claimed.pid, typeof atSpawn === 'string' && atSpawn !== '' ? atSpawn : await getProcessStartInstantAsync(claimed.pid))
}

export function buildTreeFields(): { buildTree?: string } {
  const tree = runningBuildTree()
  return tree !== null ? { buildTree: tree } : {}
}

export function markConcourseWorkerRespawn(runnerId: string, pid: number, dir?: string, startInstant?: string | null): void {
  const fields = pidFieldsOf(pid, startInstant)
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.pid = pid
        if (fields.procStart !== undefined) rec.procStart = fields.procStart
        else delete rec.procStart
        rec.lastLiveAt = Date.now()
      }
    }, dir)
  } catch (err) {
    rememberUnstampedRunnerPid(runnerId, fields, dir)
    console.error(`[daemon] ${runnerId}: the respawned runner's pid ${pid} was not stamped on its session record, which still names the dead pid: ${errorMessage(err)}`)
  }
}
