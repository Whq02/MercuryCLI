import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { RunnerChildSpec } from '../runner-link/headlessRun.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { deriveSessionKitForWorkspace, kitDeltasUnreadNote, restampSessionKit, type SessionKitV1, type KitStampSource } from '../session-seat/sessionKit.js'
import { sessionKindOfAsker, type SessionKind } from './sessionKind.js'
import { workerPidAlive } from './workerIdentity.js'
import { turnInFlightOf, sessionActivityOf, type ConcourseWorkerRecordV1, clearParkedFields, stampParked } from './record.js'
import { updateConcourseWorkers } from './store.js'
import type { ConcourseRefusalCode, ConcourseAdmitResult, ConcourseAdmitDeps } from './admit.js'
import { type ConcourseMoveV1, evaluateConcourseAdmission, type WorkspaceIsolation } from './admission.js'
import { runnerRestartReasonOf, reviveConcourseWorker } from './revive.js'
import { seatInitialPermissionMode, stampSpawnPosture, buildConcourseWorkerSpec } from './spec.js'
import { claimedPidFields, buildTreeFields } from './marks.js'
import { startTimeout } from '../../platform/async/timers.js'

function stampTakenBackAtRest(rec: ConcourseWorkerRecordV1): void {
  rec.resumedAtRestAt = Date.now()
  if (!turnInFlightOf(rec)) return
  rec.lastTurnSettledAt = rec.lastDeliveryAt
  rec.activity = sessionActivityOf(false, [], 0, rec.lastTurnSettledAt ?? null)
}

function clearReactivatedFields(rec: ConcourseWorkerRecordV1): void {
  clearParkedFields(rec)
  delete rec.stoppedAt
  delete rec.stoppedBy
  delete rec.retired
  delete rec.turnCutAt
  delete rec.turnCutBy
  delete rec.crash
  delete rec.restartReason
  delete rec.pausedAt
  delete rec.pausedBy
  delete rec.attachRequestedAt
  delete rec.attachRequestedBy
}

function recordsTakeNoWrite(error: unknown): ConcourseAdmitResult {
  return { ok: false, code: 'not-ready', error: `no session was started: ${error instanceof Error ? error.message : String(error)}` }
}

function refuseReactivate(
  rec: ConcourseWorkerRecordV1,
  code: ConcourseRefusalCode,
  error: string,
  dir?: string,
  moves?: ConcourseMoveV1[],
): ConcourseAdmitResult {
  try {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w || w.endedAt !== undefined) return
      if (w.parkedAt === undefined) stampParked(w, 'daemon:reactivate', error)
      else w.parkReason = error
    }, dir)
  } catch (error) {
    return recordsTakeNoWrite(error)
  }
  return { ok: false, code, error, ...(moves !== undefined ? { moves } : {}) }
}

export async function reactivateConcourseSession(
  rec: ConcourseWorkerRecordV1,
  args: {
    modelKey: string
    modelDisplayName?: string
    keyless?: true
    effort?: string
    permissionMode?: PermissionMode
    permissionModeTyped?: true
    runnerArgv?: string[]
    bypassConsent?: true
    kit?: SessionKitV1
    preset?: { name: string; kit: SessionKitV1; note?: string }
    by: string
    kind?: SessionKind
    restartReason?: 'update'
    atRest?: true
  },
  live: ReadonlyArray<{ workspaceId: string; isolation?: WorkspaceIsolation }>,
  deps: ConcourseAdmitDeps,
): Promise<ConcourseAdmitResult> {
  const roster = deps.roster()
  if (!roster) return refuseReactivate(rec, 'not-ready', 'parked — starting up · ↵ again retries', deps.dir)
  const kind = args.kind ?? sessionKindOfAsker(args.by)
  const display = args.modelDisplayName !== undefined ? { modelDisplayName: args.modelDisplayName } : {}
  const alive = workerPidAlive(rec)
  const held = roster.list().some(r => r.short === rec.runnerId && r.outcome === undefined)
  if (alive || held || rec.attachedAt !== undefined) {
    if (rec.parkRequestedAt !== undefined) {
      try {
        updateConcourseWorkers(workers => {
          const w = workers[rec.runnerId]
          if (!w) return
          delete w.parkRequestedAt
          delete w.parkRequestedBy
          delete w.parkRequestedReason
        }, deps.dir)
      } catch (error) {
        return recordsTakeNoWrite(error)
      }
    }
    return {
      ok: true,
      runnerId: rec.runnerId,
      sessionId: rec.sessionId,
      workspaceId: rec.workspaceId,
      modelId: rec.modelKey,
      ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
      ...display,
      ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
      liveHop: true,
    }
  }
  const claimIsolation: WorkspaceIsolation =
    (rec.isolation ?? 'exclusive') === 'exclusive' && rec.worktreePath === undefined ? 'shared' : rec.isolation
  const decision = evaluateConcourseAdmission(live, { workspaceId: rec.workspaceId, isolation: claimIsolation })
  if (!decision.admit) {
    return refuseReactivate(rec, decision.code, `parked — ${decision.reason} · ↵ again retries`, deps.dir, decision.moves)
  }
  const isolationDrift = claimIsolation !== (rec.isolation ?? 'exclusive')
  const effort = args.effort ?? rec.effort ?? 'high'
  const kit = args.kit ?? args.preset?.kit ?? deriveSessionKitForWorkspace(rec.workspaceId)
  const kitNote = kit.deltasReadError !== undefined ? kitDeltasUnreadNote(kit.deltasReadError) : undefined
  const kitSource: KitStampSource = args.kit !== undefined ? 'carried' : args.preset !== undefined ? 'preset' : 'derived'
  const restartReason = runnerRestartReasonOf(rec, args.restartReason)
  const runnerArgv = args.runnerArgv !== undefined && args.runnerArgv.length > 0 ? args.runnerArgv : rec.runnerArgv
  if (
    deps.claimWarm !== undefined &&
    kind === 'oculus' &&
    ((rec.isolation ?? 'exclusive') === 'exclusive' || rec.isolation === 'shared') &&
    rec.worktreePath === undefined &&
    (runnerArgv === undefined || runnerArgv.length === 0)
  ) {
    const claimStartedAt = Date.now()
    const claimPosture = seatInitialPermissionMode(args.permissionMode)
    const claimed = await deps.claimWarm({
      workspaceId: rec.workspaceId,
      sessionId: rec.sessionId,
      modelKey: args.modelKey,
      effort,
      permissionMode: claimPosture,
      ...(args.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
      bypassConsent: args.bypassConsent === true,
      kit,
      restartReason,
      resume: true,
    })
    if (claimed.claimed) {
      console.error(`[daemon] warm claim acked in ${Date.now() - claimStartedAt}ms: ${claimed.short} takes back session ${rec.sessionId} (${rec.runnerId} reactivated in place)`)
      const short = claimed.short
      const fields = await claimedPidFields(claimed)
      try {
        updateConcourseWorkers(workers => {
          const current = workers[rec.runnerId]
          if (!current || current.endedAt !== undefined) return
          if (short !== rec.runnerId) delete workers[rec.runnerId]
          const next: ConcourseWorkerRecordV1 = { ...current, runnerId: short, modelKey: args.modelKey, effort, lastLiveAt: Date.now() }
          if (args.keyless === true) next.keyless = true
          else delete next.keyless
          if (claimed.pid !== undefined) {
            next.pid = claimed.pid
            if (fields.procStart !== undefined) next.procStart = fields.procStart
            else delete next.procStart
          } else {
            delete next.pid
            delete next.procStart
          }
          if (isolationDrift) next.isolation = claimIsolation
          clearReactivatedFields(next)
          if (args.atRest === true) stampTakenBackAtRest(next)
          Object.assign(next, buildTreeFields())
          restampSessionKit(next, kit, kitSource, args.by)
          stampSpawnPosture(next, { permissionMode: claimPosture, ...(args.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}), ...(args.bypassConsent === true ? { bypassConsent: true as const } : {}), kind })
          workers[short] = next
        }, deps.dir)
      } catch (error) {
        roster.kill?.(short)
        return recordsTakeNoWrite(error)
      }
      deps.onSpawned?.(short, claimed.spec, claimed.pid)
      if (deps.ensureWarm !== undefined) {
        const rewarm = startTimeout(() => deps.ensureWarm!(rec.workspaceId, kit, args.bypassConsent === true), 0)
        rewarm.unref?.()
      }
      return {
        ok: true,
        ...(kitNote !== undefined ? { note: kitNote } : {}),
        runnerId: short,
        sessionId: rec.sessionId,
        workspaceId: rec.workspaceId,
        modelId: args.modelKey,
        effort,
        kitSource,
        ...(args.preset !== undefined ? { presetName: args.preset.name, ...(args.preset.note !== undefined ? { presetNote: args.preset.note } : {}) } : {}),
        ...display,
        ...(claimed.pid !== undefined ? { pid: claimed.pid } : {}),
      }
    }
    logForDebugging(`[daemon] warm claim declined for the reactivate of ${rec.sessionId} (${claimed.reason}) — respawning cold`)
    if (deps.ensureWarm !== undefined) {
      const rewarm = startTimeout(() => deps.ensureWarm!(rec.workspaceId, kit, args.bypassConsent === true), 0)
      rewarm.unref?.()
    }
  }
  const keylessDrift = (args.keyless === true) !== (rec.keyless === true)
  const runnerArgvDrift = args.runnerArgv !== undefined && args.runnerArgv.length > 0 && JSON.stringify(args.runnerArgv) !== JSON.stringify(rec.runnerArgv)
  if (args.modelKey !== rec.modelKey || effort !== rec.effort || isolationDrift || keylessDrift || runnerArgvDrift) {
    try {
      updateConcourseWorkers(workers => {
        const w = workers[rec.runnerId]
        if (!w || w.endedAt !== undefined) return
        w.modelKey = args.modelKey
        w.effort = effort
        if (args.keyless === true) w.keyless = true
        else delete w.keyless
        if (isolationDrift) w.isolation = claimIsolation
        if (runnerArgvDrift && args.runnerArgv !== undefined) w.runnerArgv = [...args.runnerArgv]
      }, deps.dir)
    } catch (error) {
      return recordsTakeNoWrite(error)
    }
  }
  const reviveRoster = {
    kill: (short: string): boolean => roster.kill?.(short) ?? false,
    has: (short: string): { present: boolean } => roster.has(short),
    registerLongLived: (short: string, spec: RunnerChildSpec): { ok: boolean; pid?: number; error?: string } => roster.registerLongLived(short, spec),
  }
  const revived = reviveConcourseWorker(
    rec.sessionId,
    args.by,
    reviveRoster,
    {
      allowStopped: true,
      clearCrash: true,
      kitOverride: kit,
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      ...(args.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
      bypassConsent: args.bypassConsent === true,
      kind,
      ...(args.restartReason !== undefined ? { restartReason: args.restartReason } : {}),
    },
    deps.dir,
  )
  if (revived.outcome === 'refused') {
    return revived.reason === 'transcript-lost'
      ? refuseReactivate(rec, 'spawn-failed', `parked — ${revived.detail}`, deps.dir)
      : refuseReactivate(rec, 'spawn-failed', `parked — ${revived.detail ?? revived.reason} · ↵ again retries`, deps.dir)
  }
  if (revived.outcome === 'applied') {
    try {
      updateConcourseWorkers(workers => {
        const w = workers[rec.runnerId]
        if (!w || w.endedAt !== undefined) return
        restampSessionKit(w, kit, kitSource, args.by)
        if (args.atRest === true) stampTakenBackAtRest(w)
      }, deps.dir)
    } catch (error) {
      console.error(`[daemon] ${rec.runnerId}: the kit of the reactivated session was not stamped on its session record: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const pid = revived.outcome === 'applied' ? revived.pid : rec.pid
  deps.onSpawned?.(
    rec.runnerId,
    buildConcourseWorkerSpec({
      runnerId: rec.runnerId,
      sessionId: rec.sessionId,
      workspaceId: rec.workspaceId,
      modelKey: args.modelKey,
      ...(args.keyless ? { keyless: true } : {}),
      effort,
      kit,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      ...(args.permissionModeTyped === true ? { permissionModeTyped: true as const } : {}),
      ...(args.bypassConsent === true ? { bypassConsent: true as const } : {}),
      resume: true,
      cwd: rec.worktreePath ?? rec.workspaceId,
      kind,
    }),
    pid,
  )
  return {
    ok: true,
    ...(kitNote !== undefined ? { note: kitNote } : {}),
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelId: args.modelKey,
    effort,
    ...(revived.outcome === 'applied' ? { kitSource } : {}),
    ...(revived.outcome === 'applied' && args.preset !== undefined ? { presetName: args.preset.name, ...(args.preset.note !== undefined ? { presetNote: args.preset.note } : {}) } : {}),
    ...display,
    ...(pid !== undefined ? { pid } : {}),
  }
}
