import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import { decideTransition, type ConcourseSessionState } from './concourseLifecycle.js'
import { reapWorkerWorktree } from './concourseWorktrees.js'
import { retireSeatProjections } from '../../engine/connector/seatProjections.js'
import { sweepScratchpadDir, scratchpadDirFor } from '../../platform/files/scratchpad.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import { writeSessionCloseReceipts } from '../switchboard/sessionReceipts.js'
import { runningBuildTree } from '../../platform/product/artifactIdentity.js'
import { workerPidAlive } from './workerIdentity.js'
import { updateConcourseWorkers, readSessionWorkers } from './store.js'
import { recordCollisionEvidence } from './collisions.js'
import { handFocusBack } from './focus.js'
import { type ConcourseWorkerRecordV1, isNewbornRecord, stampedTerminalPid, stampParked, stampStopped, turnCutStanding } from './record.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export type ConcoursePauseOutcome =
  | { outcome: 'applied' }
  | { outcome: 'noop'; reason: 'already-paused' | 'not-paused' }
  | { outcome: 'refused'; reason: 'unknown-worker' | 'terminal-immutable' | 'not-pausable-yet' }

export function pauseConcourseWorker(
  runnerId: string,
  by: string,
  dir?: string,
): ConcoursePauseOutcome {
  let out: ConcoursePauseOutcome = { outcome: 'refused', reason: 'unknown-worker' }
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec) return
    if (rec.endedAt !== undefined) {
      out = { outcome: 'refused', reason: 'terminal-immutable' }
      return
    }
    if (rec.pausedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-paused' }
      return
    }
    const derived: ConcourseSessionState =
      workerPidAlive(rec) ? 'working' : 'starting'
    const d = decideTransition(derived, 'paused')
    if (d.legal !== true) {
      out = { outcome: 'refused', reason: d.reason === 'terminal-immutable' ? 'terminal-immutable' : 'not-pausable-yet' }
      return
    }
    rec.pausedAt = Date.now()
    rec.pausedBy = by
    out = { outcome: 'applied' }
  }, dir)
  return out
}

export function resumeConcourseWorker(
  runnerId: string,
  by: string,
  dir?: string,
): ConcoursePauseOutcome {
  void by
  let out: ConcoursePauseOutcome = { outcome: 'refused', reason: 'unknown-worker' }
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec) return
    if (rec.endedAt !== undefined) {
      out = { outcome: 'refused', reason: 'terminal-immutable' }
      return
    }
    if (rec.pausedAt === undefined && rec.attachRequestedAt === undefined) {
      out = { outcome: 'noop', reason: 'not-paused' }
      return
    }
    if (rec.pausedAt !== undefined) {
      const d = decideTransition('paused', 'starting')
      if (d.legal !== true) {
        out = { outcome: 'refused', reason: 'not-pausable-yet' }
        return
      }
    }
    delete rec.pausedAt
    delete rec.pausedBy
    delete rec.attachRequestedAt
    delete rec.attachRequestedBy
    rec.lastLiveAt = Date.now()
    out = { outcome: 'applied' }
  }, dir)
  return out
}

function reapSettledWorktree(
  rec: ConcourseWorkerRecordV1,
  dir?: string,
): { branchName?: string; committedAhead?: number; files: string[] } | undefined {
  if (rec.worktreePath === undefined) return undefined
  const outcome = reapWorkerWorktree(rec.workspaceId, rec.runnerId, dir, {
    path: rec.worktreePath,
    ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
  })
  if (outcome.outcome !== 'retained') return undefined
  recordCollisionEvidence(
    {
      schema: 1,
      kind: 'authored-work-retained',
      workspaceId: rec.workspaceId,
      holders: [{ workerId: rec.runnerId, sessionId: rec.sessionId, isolation: rec.isolation }],
      observedAt: Date.now(),
      detail:
        outcome.committedAhead !== undefined && outcome.committedAhead > 0
          ? `fork retained at settle — ${outcome.committedAhead} commit(s) ahead on ${rec.branchName ?? 'its branch'}${outcome.files.length > 0 ? ` + ${outcome.files.length} uncommitted file(s)` : ''}`
          : `worktree retained at settle — authored work present (${outcome.files.length} file(s)) at ${rec.worktreePath}`,
      files: outcome.files.slice(0, 20),
      ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
    },
    dir,
  )
  return {
    ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
    ...(outcome.committedAhead !== undefined ? { committedAhead: outcome.committedAhead } : {}),
    files: outcome.files,
  }
}

export function settleConcourseWorker(runnerId: string, dir?: string): boolean {
  let settled = false
  let endedSessionId: string | undefined
  let settledRec: ConcourseWorkerRecordV1 | undefined
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (rec && rec.endedAt === undefined) {
      rec.endedAt = Date.now()
      delete rec.focusedAt
      delete rec.focusedBy
      delete rec.focusedAlso
      settled = true
      endedSessionId = rec.sessionId
      settledRec = rec
    }
  }, dir)
  if (settled && settledRec !== undefined && settledRec.parkedAt === undefined && !isNewbornRecord(settledRec)) {
    try {
      writeSessionCloseReceipts(getProjectDir(settledRec.workspaceId), settledRec.sessionId, 'settle', settledRec.agentName)
    } catch (err) {
      console.error(`[daemon] ${runnerId}: the settle close receipts of session ${settledRec.sessionId} were not written: ${errorMessage(err)}`)
    }
  }
  if (settled && settledRec !== undefined) reapSettledWorktree(settledRec, dir)
  if (settled && endedSessionId !== undefined) {
    try {
      retireSeatProjections(endedSessionId, dir)
    } catch (err) {
      console.error(`[daemon] ${runnerId}: the seat files (facts, asks, tail, progress) of ended session ${endedSessionId} were not all removed and stay stale: ${errorMessage(err)}`)
    }
  }
  if (settled && settledRec !== undefined) {
    try {
      sweepScratchpadDir(scratchpadDirFor(settledRec.worktreePath ?? settledRec.workspaceId, settledRec.sessionId))
    } catch (error) {
      passedOver(error)
    }
  }
  return settled
}

export interface ConcourseReconcileReceipt {
  settled: string[]
  live: string[]
  newbornsReleased: string[]
  parked: string[]
}

export function reconcileConcourseWorkers(
  rosterLiveShorts: ReadonlySet<string>,
  dir?: string,
): ConcourseReconcileReceipt {
  const receipt: ConcourseReconcileReceipt = { settled: [], live: [], newbornsReleased: [], parked: [] }
  updateConcourseWorkers(workers => {
    for (const rec of Object.values(workers)) {
      if (rec.endedAt !== undefined) continue
      if (rec.focusedAt !== undefined) {
        const seatPid = stampedTerminalPid(rec.focusedBy)
        if (seatPid === undefined || !isProcessAlive(seatPid)) {
          logForDebugging(`[concourse] focus stamp healed off ${rec.runnerId} (terminal ${rec.focusedBy ?? 'unnamed'} is gone)`)
          handFocusBack(rec)
        }
      }
      if (rec.parkedAt !== undefined) {
        receipt.parked.push(rec.runnerId)
        continue
      }
      if (rec.parkRequestedAt !== undefined) {
        const requestedRunnerLive = rosterLiveShorts.has(rec.runnerId) || (workerPidAlive(rec))
        if (!requestedRunnerLive) {
          stampParked(rec, rec.parkRequestedBy ?? 'daemon:reconcile')
          receipt.parked.push(rec.runnerId)
          continue
        }
      }
      if (rec.parkIntent !== undefined) {
        const intent = rec.parkIntent
        const intentRunnerLive = rosterLiveShorts.has(rec.runnerId) || workerPidAlive(rec)
        if (!intentRunnerLive || rec.pid !== intent.pid) {
          delete rec.parkIntent
          if (!intentRunnerLive) {
            stampParked(rec, intent.by)
            receipt.parked.push(rec.runnerId)
            continue
          }
        }
      }
      if (rec.stopRequestedAt !== undefined && !rosterLiveShorts.has(rec.runnerId) && !workerPidAlive(rec)) {
        stampStopped(rec, rec.stopRequestedBy ?? 'daemon:reconcile', rec.stopRequestedRetired)
        receipt.live.push(rec.runnerId)
        continue
      }
      if (rec.attachedAt !== undefined || rec.stoppedAt !== undefined || turnCutStanding(rec)) {
        receipt.live.push(rec.runnerId)
        continue
      }
      const rosterLive = rosterLiveShorts.has(rec.runnerId)
      const pidLive = rosterLive || workerPidAlive(rec)
      if (rosterLive || pidLive) {
        rec.lastLiveAt = Date.now()
        receipt.live.push(rec.runnerId)
        continue
      }
      if (rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined) {
        receipt.newbornsReleased.push(rec.runnerId)
        continue
      }
      if (rec.crash !== undefined) {
        if (rec.crash.respawning) {
          rec.crash = {
            at: rec.crash.at,
            reason: 'crashed — ended unexpectedly; enter to resume, or x x releases it',
            respawning: false,
          }
        }
        continue
      }
      const ownTree = runningBuildTree()
      const acrossBuilds = rec.buildTree !== undefined && ownTree !== null && rec.buildTree !== ownTree
      rec.crash = {
        at: Date.now(),
        reason: acrossBuilds
          ? `ended around an update to ${ownTree} — enter to resume, or x x releases it`
          : 'crashed — ended unexpectedly; enter to resume, or x x releases it',
        respawning: false,
      }
      if (acrossBuilds) rec.restartReason = 'ended'
      receipt.settled.push(rec.runnerId)
    }
  }, dir)
  for (const runnerId of receipt.newbornsReleased) settleConcourseWorker(runnerId, dir)
  if (receipt.newbornsReleased.length > 0) {
    logForDebugging(`[concourse] reconciled ${receipt.newbornsReleased.length} blank newborn(s) found dead as RELEASED (nothing to bring back): ${receipt.newbornsReleased.join(', ')}`)
  }
  if (receipt.settled.length > 0) {
    logForDebugging(`[concourse] reconciled ${receipt.settled.length} dead worker record(s) as CRASHED (rows kept): ${receipt.settled.join(', ')}`)
  }
  return receipt
}

export function listConcourseWorkers(
  rosterLiveShorts: ReadonlySet<string> | null,
  dir?: string,
): ConcourseWorkerRecordV1[] {
  const records = Object.values(readSessionWorkers(dir)).filter(r => r.endedAt === undefined)
  if (rosterLiveShorts === null) return records
  return records.filter(r => rosterLiveShorts.has(r.runnerId))
}
