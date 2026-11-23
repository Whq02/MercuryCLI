import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { makeConcourseDispatchHandler } from '../concourse-workers/concourseDispatch.js'
import type { makeConcourseAdmitHandler } from '../concourse-workers/concourseWorkers.js'
import { listConcourseWorkers, readSessionWorkers, settleConcourseWorker } from '../concourse-workers/concourseWorkers.js'
import type { ControlServerDeps } from '../control/controlServer.js'
import { currentVersion } from '../control/controlSocket.js'
import type { HandoverStateV1 } from '../control/handover.js'
import { handoverRoadOf } from '../control/handover.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import type { TaskRoster } from '../roster/roster.js'
import { requestSessionFacts, rewindSession, relayCredentialChange } from '../session-seat/sessionSeat.js'
import { composeSignInView } from '../session-seat/signInView.js'
import type { WarmRunnerDeps } from '../runner-link/warmRunner.js'
import { ensureWarmRunner, warmRunnerCount } from '../runner-link/warmRunner.js'
import { makeConcourseControl } from './concourseControl.js'
import { restartWhenIdle } from './restart.js'
import { stopVerb } from './shutdown.js'
import type { DaemonRunState } from './state.js'
import { processSweep } from './sweep.js'
import { startTimeout } from '../../platform/async/timers.js'

interface ControlServerNeeds {
  roster: TaskRoster
  handover: HandoverStateV1 | null
  handoverRef: HandoverStateV1 | null
  controlKey: string
  countBirth: <T>(door: () => Promise<T>) => Promise<T>
  concourseAdmitHandler: ReturnType<typeof makeConcourseAdmitHandler>
  concourseDispatchHandler: ReturnType<typeof makeConcourseDispatchHandler>
  warmDeps: WarmRunnerDeps
  liveWorkers: () => { live: number; liveSessions: number }
  requestShutdown: (signal: string) => void
  restartNeeds: Parameters<typeof restartWhenIdle>[1]
  bootStartInstant: Parameters<typeof processSweep>[1]['bootStartInstant']
}

export function controlServerDeps(state: DaemonRunState, { roster, handover, handoverRef, controlKey, countBirth, concourseAdmitHandler, concourseDispatchHandler, warmDeps, liveWorkers, requestShutdown, restartNeeds, bootStartInstant }: ControlServerNeeds): ControlServerDeps {
  const { breaker, dir, startedAt, maxInflight: MAX_INFLIGHT, readyPromise, foreground, bootBuildTree } = state
  return {
    ...(handoverRef !== null
      ? {
          handover: {
            roadOf: (op, raw) => handoverRoadOf(op, raw, handoverRef),
            forward: line => handoverRef.forward(line),
          },
        }
      : {}),
    roster,
    breaker,
    dir,
    startedAt,
    maxInflight: MAX_INFLIGHT,
    controlKey,
    isReady: () => state.ready,
    whenReady: () => readyPromise,
    concourseAdmit: (...args) => countBirth(() => concourseAdmitHandler(...args)),
    concourseDispatch: (...args) => countBirth(() => concourseDispatchHandler(...args)),
    concourseWithdraw: clientMessageId => concourseDispatchHandler.withdraw(clientMessageId),
    concourseWarm: req => ensureWarmRunner(req, warmDeps),
    warmRunnerCount: () => warmRunnerCount(),
    concourseList: () => {
      if (!state.roster) return []
      const entries = state.roster.list().filter(j => !j.outcome)
      const live = new Set([...entries.map(j => j.short), ...(handover?.heldRunners() ?? [])])
      const livePid = new Map(entries.map(j => [j.short, j.pid]))
      return listConcourseWorkers(live).map(r => ({
        ...r,
        workerId: r.runnerId,
        ...(livePid.get(r.runnerId) !== undefined ? { pid: livePid.get(r.runnerId) } : {}),
      }))
    },
    concourseRelease: runnerId => {
      const killed = state.roster ? state.roster.kill(runnerId) : false
      if (!killed) {
        const rec = readSessionWorkers()[runnerId]
        if (rec?.endedAt === undefined && rec?.pid !== undefined && isProcessAlive(rec.pid)) {
          return { settled: false, killed: false }
        }
      }
      const settled = settleConcourseWorker(runnerId)
      const reap = (delayMs: number): void => {
        const t = startTimeout(() => {
          const r = state.roster
          if (!r) return
          const entry = r.list().find(j => j.short === runnerId)
          if (entry?.outcome) r.kill(runnerId)
          else if (entry) reap(10_000)
        }, delayMs)
        t.unref?.()
      }
      reap(2000)
      return { settled, killed }
    },
    sessionFileRestore: async req => {
      if (state.roster === null) return { outcome: 'refused' as const, mode: 'code' as const, refusal: 'no-channel' as const, detail: 'daemon roster not ready' }
      return rewindSession(req.sessionId, { mode: 'code', userMessageId: req.userMessageId }, state.roster, undefined, { fileRestore: req })
    },
    sessionRewind: async req => {
      if (state.roster === null) {
        return { outcome: 'refused' as const, mode: req.mode, refusal: 'no-channel' as const, detail: 'daemon roster not ready' }
      }
      return rewindSession(req.sessionId, { mode: req.mode, userMessageId: req.userMessageId, ...(req.dryRun === true ? { dryRun: true } : {}) }, state.roster)
    },
    concourseControl: makeConcourseControl(state, { concourseDispatchHandler }),
    onShutdown: (reapWorkers, forwardedFromPlane) => stopVerb(state, { requestShutdown: signal => requestShutdown(signal) }, reapWorkers, forwardedFromPlane),
    hello: () => ({
      version: currentVersion(),
      buildTree: bootBuildTree,
      pid: process.pid,
      startedAt,
      ownerPid: state.currentOwnerPid,
      foreground,
      ...liveWorkers(),
      warm: warmRunnerCount(),
      restartArmed: state.restartArmed,
      predecessorPid: handover?.predecessorPids()[0] ?? null,
      predecessorPids: handover?.predecessorPids() ?? [],
    }),
    signIns: opts => {
      const view = composeSignInView(opts)
      if (opts?.refresh === true && state.roster !== null) {
        const told = relayCredentialChange(state.roster)
        for (const short of told) requestSessionFacts(short, state.roster, { immediate: true })
        if (told.length > 0) logForDebugging(`[daemon] a credential moved in the screen: told ${told.length} runner(s) to read the account again — ${told.join(', ')}`)
      }
      return view
    },
    restartWhenIdle: by => restartWhenIdle(state, restartNeeds, by),
    processSweep: request => processSweep(state, { liveWorkers, requestShutdown: signal => requestShutdown(signal), bootStartInstant }, request),
  }
}
