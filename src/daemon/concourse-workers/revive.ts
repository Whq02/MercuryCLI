import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { renameWithWin32RetrySync } from '../../platform/substrate/durablePublish.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import type { RunnerChildSpec } from '../runner-link/headlessRun.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import type { SessionKitV1 } from '../session-seat/sessionKit.js'
import { sessionKindOfAsker, type SessionKind } from './sessionKind.js'
import { workerPidAlive } from './workerIdentity.js'
import { updateConcourseWorkers, readSessionWorkers } from './store.js'
import { buildConcourseWorkerSpec, stampSpawnPosture, spawnPostureOf } from './spec.js'
import { pidFieldsOf, buildTreeFields } from './marks.js'
import { type ConcourseWorkerRecordV1, turnCutStanding, stampParked, clearParkedFields } from './record.js'
import { errorMessage, isENOENT } from '../../platform/errors/errors.js'

export function migrateTranscriptHomeToLaw(rec: {
  sessionId: string
  workspaceId: string
  worktreePath?: string
}): void {
  if (rec.worktreePath === undefined) return
  try {
    const lawHome = getProjectDir(rec.workspaceId)
    const lawPath = join(lawHome, `${rec.sessionId}.jsonl`)
    const legacyPath = join(getProjectDir(rec.worktreePath), `${rec.sessionId}.jsonl`)
    if (!existsSync(lawPath) && existsSync(legacyPath)) {
      mkdirSync(lawHome, { recursive: true })
      renameWithWin32RetrySync(legacyPath, lawPath)
    }
  } catch (err) {
    if (!isENOENT(err)) {
      console.error(`[daemon] session ${rec.sessionId}: its transcript was not moved from the worktree's project folder to the workspace's, so a resume does not find its history: ${errorMessage(err)}`)
    }
  }
}

export type ConcourseAttachOutcome =
  | { outcome: 'applied'; runnerId: string }
  | { outcome: 'draining'; runnerId: string }
  | { outcome: 'noop'; reason: 'already-attached'; runnerId: string }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'terminal-immutable' | 'attached-elsewhere' | 'no-kill-channel'
      detail?: string
    }

export function attachYieldConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
): ConcourseAttachOutcome {
  let out: ConcourseAttachOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.attachedAt !== undefined) {
      const recordedPid = /^operator:(\d+)$/.exec(rec.attachedBy ?? '')?.[1]
      const callerMatches = rec.attachedBy === undefined || rec.attachedBy === 'operator' || rec.attachedBy === by
      const holderDead = recordedPid !== undefined && !isProcessAlive(Number(recordedPid))
      if (!callerMatches && !holderDead) {
        out = {
          outcome: 'refused',
          reason: 'attached-elsewhere',
          detail: 'this session is open in another terminal — leave it there, then ↵ here',
        }
        return
      }
      rec.attachedBy = by
      rec.lastAttachGrantAt = Date.now()
      out = { outcome: 'noop', reason: 'already-attached', runnerId: rec.runnerId }
      return
    }
    if (rec.attachRequestedAt === undefined) {
      rec.attachRequestedAt = Date.now()
      rec.attachRequestedBy = by
    }
    const alive = workerPidAlive(rec)
    const turnInFlight =
      alive &&
      rec.lastDeliveryAt !== undefined &&
      (rec.lastTurnSettledAt === undefined || rec.lastTurnSettledAt < rec.lastDeliveryAt)
    if (turnInFlight) {
      out = { outcome: 'draining', runnerId: rec.runnerId }
      return
    }
    if (alive) {
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — enter refused`,
        }
        return
      }
    } else {
      roster?.kill(rec.runnerId)
    }
    rec.attachedAt = Date.now()
    rec.attachedBy = by
    rec.lastAttachGrantAt = Date.now()
    delete rec.attachRequestedAt
    delete rec.attachRequestedBy
    delete rec.crash
    rec.lastLiveAt = Date.now()
    migrateTranscriptHomeToLaw(rec)
    out = { outcome: 'applied', runnerId: rec.runnerId }
  }, dir)
  return out
}

export type ConcourseDetachOutcome =
  | { outcome: 'applied'; runnerId: string; pid?: number }
  | { outcome: 'noop'; reason: 'not-attached' }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'respawn-failed' | 'superseded-by-reattach'
      detail?: string
    }

export function detachRespawnConcourseSession(
  sessionId: string,
  by: string,
  roster:
    | {
        kill(short: string): boolean
        has(short: string): { present: boolean }
        registerLongLived(
          short: string,
          spec: RunnerChildSpec,
        ): { ok: boolean; pid?: number; error?: string }
      }
    | undefined,
  dir?: string,
  opts?: { mintedAtMs?: number },
): ConcourseDetachOutcome {
  void by
  const rec = Object.values(readSessionWorkers(dir)).find(
    r => r.sessionId === sessionId && r.endedAt === undefined,
  )
  if (!rec) return { outcome: 'refused', reason: 'unknown-session' }
  if (rec.attachedAt === undefined) return { outcome: 'noop', reason: 'not-attached' }
  if (
    opts?.mintedAtMs !== undefined &&
    rec.lastAttachGrantAt !== undefined &&
    rec.lastAttachGrantAt > opts.mintedAtMs
  ) {
    return {
      outcome: 'refused',
      reason: 'superseded-by-reattach',
      detail: 'the session was re-entered after this hand-back was queued — nothing to do',
    }
  }
  if (!roster)
    return { outcome: 'refused', reason: 'respawn-failed', detail: 'daemon roster not ready' }
  const spec = buildConcourseWorkerSpec({
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelKey: rec.modelKey,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.title !== undefined ? { title: rec.title } : {}),
    ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
    ...(rec.kit !== undefined ? { kit: rec.kit } : {}),
    ...(rec.kind !== undefined ? { kind: rec.kind } : {}),
    resume: true,
    cwd: rec.worktreePath ?? rec.workspaceId,
  })
  let reg = roster.registerLongLived(rec.runnerId, spec)
  if (!reg.ok && roster.has(rec.runnerId).present) {
    roster.kill(rec.runnerId)
    reg = roster.registerLongLived(rec.runnerId, spec)
  }
  if (!reg.ok) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w) {
        delete w.attachedAt
        delete w.attachedBy
        delete w.attachRequestedAt
        delete w.attachRequestedBy
      }
    }, dir)
    return {
      outcome: 'refused',
      reason: 'respawn-failed',
      ...(reg.error !== undefined ? { detail: reg.error } : {}),
    }
  }
  try {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w) return
      delete w.attachedAt
      delete w.attachedBy
      delete w.attachRequestedAt
      delete w.attachRequestedBy
      delete w.pausedAt
      delete w.pausedBy
      w.lastLiveAt = Date.now()
      if (reg.pid !== undefined) Object.assign(w, pidFieldsOf(reg.pid))
    }, dir)
  } catch (error) {
    roster.kill(rec.runnerId)
    return { outcome: 'refused', reason: 'respawn-failed', detail: error instanceof Error ? error.message : String(error) }
  }
  return {
    outcome: 'applied',
    runnerId: rec.runnerId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
  }
}

export type ConcourseReviveOutcome =
  | { outcome: 'applied'; runnerId: string; pid?: number }
  | { outcome: 'noop'; reason: 'already-live' }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'attached' | 'stopped' | 'respawn-failed' | 'transcript-lost'
      detail?: string
    }

export function concourseTranscriptPath(rec: Pick<ConcourseWorkerRecordV1, 'sessionId' | 'workspaceId'>): string {
  return join(getProjectDir(rec.workspaceId), `${rec.sessionId}.jsonl`)
}

export function runnerRestartReasonOf(
  rec: Pick<ConcourseWorkerRecordV1, 'crash' | 'turnCutAt' | 'restartReason'>,
  override?: ConcourseWorkerRecordV1['restartReason'],
): 'crash' | 'stop' | 'relaunch' | 'ended' | 'update' {
  if (override !== undefined) return override
  if (rec.restartReason !== undefined) return rec.restartReason
  if (rec.crash !== undefined) return 'crash'
  return turnCutStanding(rec) ? 'stop' : 'relaunch'
}

export function reviveConcourseWorker(
  sessionId: string,
  by: string,
  roster:
    | {
        kill(short: string): boolean
        has(short: string): { present: boolean; alive?: boolean }
        registerLongLived(
          short: string,
          spec: RunnerChildSpec,
        ): { ok: boolean; pid?: number; error?: string }
      }
    | undefined,
  opts?: {
    allowStopped?: boolean
    clearCrash?: boolean
    kitOverride?: SessionKitV1
    modelOverride?: string
    permissionMode?: PermissionMode
    permissionModeTyped?: true
    bypassConsent?: boolean
    kind?: SessionKind
    restartReason?: 'update'
  },
  dir?: string,
): ConcourseReviveOutcome {
  const rec = Object.values(readSessionWorkers(dir)).find(
    r => r.sessionId === sessionId && r.endedAt === undefined,
  )
  if (!rec) return { outcome: 'refused', reason: 'unknown-session' }
  if (rec.attachedAt !== undefined)
    return { outcome: 'refused', reason: 'attached', detail: 'the session is with the operator' }
  if (rec.stoppedAt !== undefined && opts?.allowStopped !== true)
    return {
      outcome: 'refused',
      reason: 'stopped',
      detail: 'stopped — the session was stopped on purpose; resume it to bring it back',
    }
  if (workerPidAlive(rec)) return { outcome: 'noop', reason: 'already-live' }
  if (!roster)
    return { outcome: 'refused', reason: 'respawn-failed', detail: 'daemon roster not ready' }
  if (roster.has(rec.runnerId).alive === true) return { outcome: 'noop', reason: 'already-live' }
  if (!existsSync(concourseTranscriptPath(rec))) {
    const detail = 'its transcript is gone — nothing to resume it around; start a new session'
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w || w.endedAt !== undefined) return
      if (w.parkedAt === undefined) stampParked(w, by, detail)
      else w.parkReason = detail
    }, dir)
    return { outcome: 'refused', reason: 'transcript-lost', detail }
  }
  const reviveKit = opts?.kitOverride ?? rec.kit
  const reviveModel = opts?.modelOverride ?? rec.modelKey
  const revivePosture = opts?.permissionMode ?? rec.permissionMode
  const reviveTyped = opts?.permissionMode !== undefined ? opts.permissionModeTyped === true : rec.permissionModeTyped === true
  const reviveConsent = opts?.bypassConsent ?? rec.bypassConsent === true
  const reviveKind = opts?.kind ?? rec.kind ?? sessionKindOfAsker(by)
  const restartReason = runnerRestartReasonOf(rec, opts?.restartReason)
  const spec = buildConcourseWorkerSpec({
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelKey: reviveModel,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.title !== undefined ? { title: rec.title } : {}),
    ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
    ...(reviveKit !== undefined ? { kit: reviveKit } : {}),
    ...(revivePosture !== undefined ? { permissionMode: revivePosture } : {}),
    ...(reviveTyped ? { permissionModeTyped: true as const } : {}),
    ...(reviveConsent ? { bypassConsent: true as const } : {}),
    restartReason,
    resume: true,
    cwd: rec.worktreePath ?? rec.workspaceId,
    kind: reviveKind,
  })
  const reg = roster.registerLongLived(rec.runnerId, spec)
  if (!reg.ok)
    return {
      outcome: 'refused',
      reason: 'respawn-failed',
      ...(reg.error !== undefined ? { detail: reg.error } : {}),
    }
  try {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w) return
      delete w.stoppedAt
      delete w.stoppedBy
      delete w.retired
      delete w.turnCutAt
      delete w.turnCutBy
      delete w.restartReason
      clearParkedFields(w)
      if (opts?.clearCrash === true) delete w.crash
      if (opts?.modelOverride !== undefined) {
        w.modelKey = opts.modelOverride
        delete w.pendingModelKey
      }
      stampSpawnPosture(w, spawnPostureOf(spec))
      w.lastLiveAt = Date.now()
      if (reg.pid !== undefined) Object.assign(w, pidFieldsOf(reg.pid))
      Object.assign(w, buildTreeFields())
    }, dir)
  } catch (error) {
    roster.kill(rec.runnerId)
    return { outcome: 'refused', reason: 'respawn-failed', detail: error instanceof Error ? error.message : String(error) }
  }
  return {
    outcome: 'applied',
    runnerId: rec.runnerId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
  }
}
