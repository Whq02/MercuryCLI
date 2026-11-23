import { randomUUID } from '../../platform/primitives/crypto.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isProcessAlive, getProcessStartTokenAsync } from '../control/ownerWatch.js'
import { RetirementFence } from '../runner-link/runnerQuiescence.js'
import type { RunnerDoor } from '../runner-link/runnerConnection.js'
import { workerPidAlive } from './workerIdentity.js'
import { tokenBinding } from '../process-sweep/processSweep.js'
import { readProcessTreeUnder, readProcessBirth } from '../process-sweep/processTree.js'
import { endProcessTree } from '../../platform/processes/processGroup.js'
import { pollUntil, withDeadline } from '../../platform/async/deadline.js'
import { updateConcourseWorkers, readSessionWorkers } from './store.js'
import { isNewbornRecord, turnInFlightOf, stampParked, type ConcourseWorkerRecordV1, withdrawTerminalParkRequest, stampedTerminalPid } from './record.js'
import { settleConcourseWorker } from './settle.js'

export const PARK_DRAIN_CUT_REASON = 'parked — turn cut at the drain ceiling'

export type ConcourseParkOutcome =
  | { outcome: 'applied'; runnerId: string; released: boolean }
  | { outcome: 'draining'; runnerId: string }
  | { outcome: 'noop'; reason: 'already-parked' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'no-kill-channel'; detail?: string }

export function parkConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  opts?: { reason?: string; afterTurn?: boolean },
): ConcourseParkOutcome {
  let out: ConcourseParkOutcome = { outcome: 'refused', reason: 'unknown-session' }
  let releaseNewborn: string | undefined
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (rec.parkedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-parked' }
      return
    }
    const alive = workerPidAlive(rec)
    if (alive && !isNewbornRecord(rec) && turnInFlightOf(rec) && opts?.afterTurn !== false) {
      if (rec.parkRequestedAt === undefined) {
        rec.parkRequestedAt = Date.now()
        rec.parkRequestedBy = by
        if (opts?.reason !== undefined) rec.parkRequestedReason = opts.reason
      }
      out = { outcome: 'draining', runnerId: rec.runnerId }
      return
    }
    if (alive) {
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — record left live`,
        }
        return
      }
    } else {
      roster?.kill(rec.runnerId)
    }
    if (isNewbornRecord(rec)) {
      releaseNewborn = rec.runnerId
      out = { outcome: 'applied', runnerId: rec.runnerId, released: true }
      return
    }
    stampParked(rec, by, opts?.reason)
    out = { outcome: 'applied', runnerId: rec.runnerId, released: false }
  }, dir)
  if (releaseNewborn !== undefined) settleConcourseWorker(releaseNewborn, dir)
  return out
}

export function cutAtDrainCeiling(sessionId: string, pid: number, dir?: string): boolean {
  return Object.values(readSessionWorkers(dir)).some(r => r.sessionId === sessionId && r.pid === pid && r.parkReason === PARK_DRAIN_CUT_REASON)
}

export const RETIREMENT_EXIT_WAIT_MS = 10_000

export type ConcourseRetireOutcome =
  | { outcome: 'parked'; runnerId: string }
  | { outcome: 'refused'; runnerId?: string; reason: string; fenced: boolean }

const retirementFences = new Map<string, RetirementFence>()

export function retirementFenced(runnerId: string): boolean {
  return retirementFences.get(runnerId)?.fenced === true
}

export function retirementRefusal(rec: Pick<ConcourseWorkerRecordV1, 'lastDeliveryAt' | 'lastTurnSettledAt' | 'pid' | 'procStart' | 'parkedAt' | 'endedAt' | 'stoppedAt' | 'attachedAt' | 'bornBlankAt'>): string | null {
  if (rec.endedAt !== undefined) return 'the session already ended'
  if (rec.parkedAt !== undefined) return 'the session is already parked'
  if (rec.stoppedAt !== undefined) return 'the session is stopped'
  if (rec.attachedAt !== undefined) return 'a terminal is attached to the session'
  if (turnInFlightOf(rec)) return 'a turn is in flight'
  if (!workerPidAlive(rec)) return 'the runner is not alive'
  return null
}

export async function retireConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean; door(short: string): RunnerDoor | undefined; has(short: string): { alive: boolean; present: boolean }; expectExit?(short: string, expected: boolean): boolean; onExit?(short: string, listener: () => void): () => void },
  dir?: string,
  opts?: { reason?: string; exitWaitMs?: number; requestStands?: true },
): Promise<ConcourseRetireOutcome> {
  const { quiesceSessionRunner } = await import('../session-seat/sessionSeat.js')
  if (opts?.requestStands !== true) {
    const asked = Object.values(readSessionWorkers(dir)).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    const requested = asked === undefined ? undefined : requestedRetirements.get(asked.runnerId)
    if (asked !== undefined && requested !== undefined && (await requested)) return { outcome: 'parked', runnerId: asked.runnerId }
  }
  const rec = Object.values(readSessionWorkers(dir)).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (!rec) return { outcome: 'refused', reason: 'unknown-session', fenced: false }
  const runnerId = rec.runnerId
  const standing = retirementFences.get(runnerId)
  if (standing !== undefined) {
    const result = await standing.demand()
    return result.outcome === 'parked' ? { outcome: 'parked', runnerId } : { outcome: 'refused', runnerId, reason: result.reason, fenced: result.fenced }
  }
  const current = (): ConcourseWorkerRecordV1 | undefined => readSessionWorkers(dir)[runnerId]
  const requestedAt = rec.parkRequestedAt
  const fence = new RetirementFence({
    request: request => quiesceSessionRunner(runnerId, request, roster),
    refusal: () => {
      const now = current()
      if (now === undefined) return 'the record vanished'
      if (opts?.requestStands === true) {
        if (now.parkRequestedAt === undefined || now.parkRequestedAt !== requestedAt) return 'the park request was withdrawn'
        if (stopOutranksPark(now)) return 'a stop is in progress'
      }
      return retirementRefusal(now)
    },
    persistIntent: token => {
      const now = current()
      updateConcourseWorkers(workers => {
        const w = workers[runnerId]
        if (!w) throw new Error('the record vanished before the intent landed')
        w.parkIntent = { token, by, at: Date.now(), pid: now?.pid ?? 0 }
        delete w.parkRefused
      }, dir)
    },
    clearIntent: token => {
      updateConcourseWorkers(workers => {
        const w = workers[runnerId]
        if (w?.parkIntent?.token === token) delete w.parkIntent
      }, dir)
    },
    expectExit: expected => {
      roster.expectExit?.(runnerId, expected)
    },
    observeExit: async () => {
      const waitMs = opts?.exitWaitMs ?? RETIREMENT_EXIT_WAIT_MS
      if (waitMs <= 0) return false
      const exited = (): boolean => {
        const seat = roster.has(runnerId)
        const now = current()
        return !seat.alive && !(now !== undefined && workerPidAlive(now))
      }
      if (roster.onExit === undefined) {
        return pollUntil(() => (exited() ? true : undefined), 50, waitMs, () => false)
      }
      const until = Date.now() + waitMs
      let stop: (() => void) | undefined
      try {
        const exitEvent = new Promise<void>(resolve => {
          stop = roster.onExit!(runnerId, () => {
            stop?.()
            resolve()
          })
        })
        if (exited()) return true
        const leftForEvent = until - Date.now()
        if (leftForEvent <= 0) return false
        const waited = await withDeadline(exitEvent.then(() => 'exited' as const), leftForEvent, () => 'timeout' as const)
        if (exited()) return true
        if (waited === 'timeout') return false
        const leftForPoll = until - Date.now()
        if (leftForPoll <= 0) return false
        return pollUntil(() => (exited() ? true : undefined), left => Math.min(50, Math.max(1, left)), leftForPoll, () => false)
      } finally {
        stop?.()
      }
    },
    persistParked: token => {
      updateConcourseWorkers(workers => {
        const w = workers[runnerId]
        if (!w || w.parkIntent?.token !== token) throw new Error('the park intent changed under the retirement')
        delete w.parkIntent
        stampParked(w, by, opts?.reason)
      }, dir)
    },
  })
  retirementFences.set(runnerId, fence)
  try {
    const result = await fence.retire(randomUUID().replace(/-/g, ''))
    if (result.outcome === 'parked') return { outcome: 'parked', runnerId }
    if (opts?.requestStands !== true) {
      updateConcourseWorkers(workers => {
        const w = workers[runnerId]
        if (w && w.parkedAt === undefined) w.parkRefused = { reason: result.reason, at: Date.now(), by }
      }, dir)
    }
    return { outcome: 'refused', runnerId, reason: result.reason, fenced: result.fenced }
  } finally {
    if (retirementFences.get(runnerId) === fence && !fence.fenced) retirementFences.delete(runnerId)
  }
}

export async function completeFencedRetirement(runnerId: string, dir?: string): Promise<boolean> {
  const fence = retirementFences.get(runnerId)
  if (fence !== undefined) {
    if (!fence.fenced) return false
    const result = await fence.reconcileExit()
    if (!fence.fenced && retirementFences.get(runnerId) === fence) retirementFences.delete(runnerId)
    return result.outcome === 'parked'
  }
  let completed = false
  updateConcourseWorkers(workers => {
    const w = workers[runnerId]
    if (!w || w.endedAt !== undefined || w.parkedAt !== undefined || w.parkIntent === undefined) return
    if (workerPidAlive(w)) return
    const intent = w.parkIntent
    delete w.parkIntent
    stampParked(w, intent.by)
    completed = true
  }, dir)
  return completed
}

export function completeRequestedPark(
  runnerId: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
): boolean {
  const standing = readSessionWorkers(dir)[runnerId]
  if (!standing || standing.endedAt !== undefined || standing.parkedAt !== undefined || standing.parkRequestedAt === undefined) return false
  let completed = false
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec || rec.endedAt !== undefined || rec.parkedAt !== undefined || rec.parkRequestedAt === undefined) return
    if (stopOutranksPark(rec) || workerPidAlive(rec)) return
    roster?.kill(rec.runnerId)
    stampParked(rec, rec.parkRequestedBy ?? 'daemon', rec.parkRequestedReason)
    completed = true
  }, dir)
  return completed
}

function stopOutranksPark(rec: Pick<ConcourseWorkerRecordV1, 'stopRequestedAt' | 'stoppedAt'>): boolean {
  return rec.stopRequestedAt !== undefined || rec.stoppedAt !== undefined
}

const requestedRetirements = new Map<string, Promise<boolean>>()

export function retireRequestedPark(
  runnerId: string,
  roster: Parameters<typeof retireConcourseSession>[2],
  dir?: string,
  opts?: { exitWaitMs?: number },
): Promise<boolean> {
  const standing = requestedRetirements.get(runnerId)
  if (standing !== undefined) return standing
  const retirement: Promise<boolean> = retireForRequest(runnerId, roster, dir, opts).finally(() => {
    if (requestedRetirements.get(runnerId) === retirement) requestedRetirements.delete(runnerId)
  })
  requestedRetirements.set(runnerId, retirement)
  return retirement
}

async function retireForRequest(
  runnerId: string,
  roster: Parameters<typeof retireConcourseSession>[2],
  dir?: string,
  opts?: { exitWaitMs?: number },
): Promise<boolean> {
  const rec = readSessionWorkers(dir)[runnerId]
  if (!rec || rec.endedAt !== undefined || rec.parkedAt !== undefined || rec.parkRequestedAt === undefined) return false
  if (stopOutranksPark(rec) || retirementFences.has(runnerId) || turnInFlightOf(rec) || !workerPidAlive(rec)) return false
  const retired = await retireConcourseSession(rec.sessionId, rec.parkRequestedBy ?? 'daemon', roster, dir, {
    ...(rec.parkRequestedReason !== undefined ? { reason: rec.parkRequestedReason } : {}),
    ...(opts?.exitWaitMs !== undefined ? { exitWaitMs: opts.exitWaitMs } : {}),
    requestStands: true,
  })
  return retired.outcome === 'parked'
}

export function operatorTookSessionBack(sessionId: string, dir?: string): boolean {
  const standing = Object.values(readSessionWorkers(dir)).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (!standing || standing.parkRequestedAt === undefined) return false
  let withdrawn = false
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (rec) withdrawn = withdrawTerminalParkRequest(rec)
  }, dir)
  return withdrawn
}

export function withdrawParkRequestsBy(by: string, runnerIds: readonly string[], dir?: string): string[] {
  const asked = (rec: ConcourseWorkerRecordV1 | undefined): rec is ConcourseWorkerRecordV1 => rec !== undefined && rec.endedAt === undefined && rec.parkRequestedBy === by
  const standing = readSessionWorkers(dir)
  if (!runnerIds.some(runnerId => asked(standing[runnerId]))) return []
  const withdrawn: string[] = []
  updateConcourseWorkers(workers => {
    for (const runnerId of runnerIds) {
      const rec = workers[runnerId]
      if (!asked(rec)) continue
      delete rec.parkRequestedAt
      delete rec.parkRequestedBy
      delete rec.parkRequestedReason
      withdrawn.push(runnerId)
    }
  }, dir)
  return withdrawn
}

export const HOSTLESS_RUNNER_GRACE_MS = 3_000

export async function endRunnersLeftWithoutHost(
  hosted: (runnerId: string) => boolean,
  dir?: string,
  opts?: { graceMs?: number },
): Promise<Array<{ runnerId: string; pid: number }>> {
  const ended: Array<{ runnerId: string; pid: number }> = []
  for (const rec of Object.values(readSessionWorkers(dir))) {
    const pid = rec.pid
    if (rec.endedAt !== undefined || rec.attachedAt !== undefined || pid === undefined || rec.procStart === undefined) continue
    if (pid <= 1 || pid === process.pid) continue
    if (hosted(rec.runnerId) || !isProcessAlive(pid)) continue
    const under = await readProcessTreeUnder(pid)
    if (under === null) {
      logForDebugging(`[daemon] ${rec.runnerId} (pid ${pid}) has no host and is passed over: this daemon stands in its tree or its group, or the process table does not say where this daemon stands`)
      continue
    }
    if (tokenBinding(rec.procStart, await getProcessStartTokenAsync(pid, rec.procStart)) !== 'bound') continue
    await endProcessTree(pid, 'SIGTERM')
    await pollUntil(
      () => (isProcessAlive(pid) || under.some(member => isProcessAlive(member.pid)) ? undefined : true),
      50,
      opts?.graceMs ?? HOSTLESS_RUNNER_GRACE_MS,
      () => false,
    )
    let gone = !isProcessAlive(pid)
    if (!gone) {
      const still = tokenBinding(rec.procStart, await getProcessStartTokenAsync(pid, rec.procStart))
      if (still === 'bound') {
        await endProcessTree(pid, 'SIGKILL')
        gone = !isProcessAlive(pid)
      } else {
        gone = still === 'stranger'
      }
    }
    for (const member of under) {
      if (!isProcessAlive(member.pid)) continue
      if (tokenBinding(member.birth, await readProcessBirth(member.pid)) === 'bound') await endProcessTree(member.pid, 'SIGKILL')
    }
    if (gone) ended.push({ runnerId: rec.runnerId, pid })
  }
  return ended
}

export function pendingParkRequests(dir?: string): string[] {
  return Object.values(readSessionWorkers(dir))
    .filter(r => r.endedAt === undefined && r.parkedAt === undefined && r.parkRequestedAt !== undefined && workerPidAlive(r))
    .map(r => r.runnerId)
}

export interface ConcourseParkAllReceipt {
  parked: string[]
  draining: string[]
  released: string[]
  skipped: string[]
  refused: string[]
}

export function parkAllConcourseSessions(
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  opts?: { reason?: string; exceptFocusedByLiveTerminal?: boolean; afterTurn?: boolean },
): ConcourseParkAllReceipt {
  const receipt: ConcourseParkAllReceipt = { parked: [], draining: [], released: [], skipped: [], refused: [] }
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt !== undefined || rec.parkedAt !== undefined) continue
    if (rec.stoppedAt !== undefined || rec.attachedAt !== undefined) {
      receipt.skipped.push(rec.runnerId)
      continue
    }
    if (opts?.exceptFocusedByLiveTerminal === true && rec.focusedAt !== undefined && rec.focusedBy !== by) {
      const seatPid = stampedTerminalPid(rec.focusedBy)
      if (seatPid !== undefined && isProcessAlive(seatPid)) {
        receipt.skipped.push(rec.runnerId)
        continue
      }
    }
    const out = parkConcourseSession(rec.sessionId, by, roster, dir, {
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts?.afterTurn !== undefined ? { afterTurn: opts.afterTurn } : {}),
    })
    if (out.outcome === 'applied') (out.released ? receipt.released : receipt.parked).push(rec.runnerId)
    else if (out.outcome === 'draining') receipt.draining.push(rec.runnerId)
    else if (out.outcome === 'refused') receipt.refused.push(rec.runnerId)
  }
  return receipt
}
