import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage, getErrnoCode } from '../../platform/errors/errors.js'
import { concourseWorkersPath, readSessionWorkersSnapshot, reconcileConcourseWorkers, unreadSessionRecordsRefusal } from '../concourse-workers/concourseWorkers.js'
import type { ControlServerDeps } from '../control/controlServer.js'
import { daemonHomeStands } from '../control/daemonHome.js'
import { sweepIdleEmptyConcourseSessions } from '../control/idleRetirement.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import { tokenBinding, type ProcessSweepDaemonAnswer, type ProcessSweepRunnerRecord } from '../process-sweep/processSweep.js'
import { recordProcessCensusAtBoot, sweepRunnerRecord } from '../process-sweep/processSweepRun.js'
import { fileMoveStamp } from '../saturn/saturnTicker.js'
import { sweepIdleWarmRunners, warmRunnerShorts, type WarmRunnerDeps } from '../runner-link/warmRunner.js'
import type { periodicArmer } from './periodic.js'
import type { DaemonRunState } from './state.js'
import { startImmediate } from '../../platform/async/timers.js'

type ProcessSweepDoor = NonNullable<ControlServerDeps['processSweep']>

interface ReconcileNeeds {
  warmDeps: WarmRunnerDeps
  armPeriodic: ReturnType<typeof periodicArmer>
}

interface ProcessSweepNeeds {
  liveWorkers: () => { live: number; liveSessions: number }
  requestShutdown: (signal: string) => void
  bootStartInstant: string | null
}

export function armReconcile(state: DaemonRunState, { warmDeps, armPeriodic }: ReconcileNeeds): void {
  state.bootStep = 'the boot reconcile'
  const rosteredOrHeld = (): Set<string> =>
    new Set([...(state.roster ? state.roster.list().filter(j => !j.outcome).map(j => j.short) : []), ...(state.handover?.heldRunners() ?? [])])
  const liveShorts = rosteredOrHeld()
  const bootReconcile = unreadSessionRecordsRefusal() === null ? reconcileConcourseWorkers(liveShorts) : null
  void recordProcessCensusAtBoot({ rpc: async () => ({ ok: false, code: 'ENOTSUP', error: 'the daemon reads its own facts in-process' }) })
    .then(census => logForDebugging(`[daemon] boot process census: ${census.entries.length} Mercury process(es) read, ${census.entries.filter(entry => entry.classification === 'stale').length} stale — nothing ended at boot`))
    .catch(error => logForDebugging(`[daemon] boot process census failed: ${error}`))
  let reconcileRosterSig = [...liveShorts].sort().join(' ')
  let reconcileRecordsStamp = fileMoveStamp(concourseWorkersPath())
  let reconcileHadLive = bootReconcile === null || bootReconcile.live.length > 0
  const namedReconcileFailures = new Set<string>()
  const reconcileTick = (): void => {
    const roster = state.roster
    try {
      if (!daemonHomeStands('the reconcile tick')) return
      const live = rosteredOrHeld()
      const rosterSig = [...live].sort().join(' ')
      const stamp = fileMoveStamp(concourseWorkersPath())
      if (rosterSig !== reconcileRosterSig || stamp !== reconcileRecordsStamp || reconcileHadLive) {
        reconcileRosterSig = rosterSig
        const receipt = reconcileConcourseWorkers(live)
        reconcileHadLive = receipt.live.length > 0
        try {
          sweepIdleEmptyConcourseSessions(roster ?? undefined)
        } catch (e) {
          logForDebugging(`[daemon] idle retirement sweep threw (ignored): ${e}`)
        }
        reconcileRecordsStamp = fileMoveStamp(concourseWorkersPath())
      }
    } catch (e) {
      const words = errorMessage(e)
      const key = getErrnoCode(e) ?? words
      if (!namedReconcileFailures.has(key)) {
        namedReconcileFailures.add(key)
        console.error(`[daemon] the reconcile tick failed, so the records of ended sessions are not corrected and idle retirement does not run until it succeeds: ${words}`)
      }
    }
    try {
      sweepIdleWarmRunners(warmDeps)
    } catch (e) {
      logForDebugging(`[daemon] warm runner sweep threw (ignored): ${e}`)
    }
  }
  armPeriodic('the reconcile tick', reconcileTick)
}

export async function processSweep(state: DaemonRunState, { liveWorkers, requestShutdown, bootStartInstant }: ProcessSweepNeeds, request: Parameters<ProcessSweepDoor>[0]): ReturnType<ProcessSweepDoor> {
  const snapshot = readSessionWorkersSnapshot()
  const known = snapshot.state === 'known' ? snapshot.workers : null
  const live = state.roster === null ? [] : state.roster.liveWorkerFacts()
  const warm = new Set(warmRunnerShorts())
  const runners: ProcessSweepRunnerRecord[] = []
  const seen = new Set<string>()
  for (const worker of live) {
    const record = known?.[worker.short]
    if (record !== undefined) seen.add(worker.short)
    runners.push(sweepRunnerRecord(record, worker.pid ?? record?.pid, warm.has(worker.short)))
  }
  for (const [short, record] of Object.entries(known ?? {})) {
    if (!seen.has(short)) runners.push(sweepRunnerRecord(record, record.pid, false))
  }
  const facts: ProcessSweepDaemonAnswer = { pid: process.pid, ownerPid: state.currentOwnerPid, ...liveWorkers(), persist: state.persist, runners }
  if (request.action === 'facts') return { ok: true, op: 'processSweep', action: 'facts', facts }
  const refuse = (reason: string, road: 'daemon' | 'none' = 'daemon') => ({ ok: true as const, op: 'processSweep' as const, action: 'end' as const, ended: false, road, reason })
  const expected = request.expected
  if (expected === undefined) return refuse('no reviewed identity was given', 'none')
  if (expected.kind === 'daemon') {
    if (expected.process.pid !== process.pid || tokenBinding(bootStartInstant, expected.startToken) !== 'bound') return refuse('the reviewed identity is not this daemon', 'none')
    if (state.persist || state.currentOwnerPid === null) return refuse('this daemon persists by its own posture')
    if (isProcessAlive(state.currentOwnerPid)) return refuse(`the owner pid ${state.currentOwnerPid} is alive`)
    const { live: liveNow, liveSessions } = liveWorkers()
    if (liveNow > 0 || liveSessions > 0) return refuse(`${liveNow} live worker(s) use this daemon`)
    if (runners.some(runner => !runner.warm && runner.endedAt === undefined && runner.stoppedAt === undefined && runner.parkedAt === undefined)) return refuse('an open session record is held here')
    logForDebugging(`[daemon] process sweep: no owner, session, schedule or persistence holds pid ${process.pid} — shutting down at the operator's request`)
    startImmediate(() => requestShutdown('control:processSweep'))
    return { ok: true, op: 'processSweep', action: 'end', ended: true, road: 'daemon', reason: 'the daemon confirmed nothing uses it and shut itself down' }
  }
  if (expected.kind === 'runner') {
    const match = runners.find(runner => runner.pid === expected.process.pid)
    if (match === undefined || tokenBinding(match.procStart, expected.startToken) !== 'bound') return refuse('this daemon does not roster the reviewed runner', 'none')
    if (match.warm) return refuse('a warm runner is held by the daemon')
    if (match.endedAt === undefined && match.stoppedAt === undefined) return refuse('the runner\'s session is still open here')
    const short = live.find(worker => worker.pid === match.pid)?.short ?? Object.entries(known ?? {}).find(([, record]) => record.pid === match.pid)?.[0]
    if (short === undefined || state.roster === null || !state.roster.kill(short)) return refuse(`the daemon holds no live handle for the released runner pid ${match.pid}; if it is truly abandoned, end it by hand`, 'none')
    logForDebugging(`[daemon] process sweep: killed the released runner ${short} (pid ${match.pid}) at the operator's request`)
    return { ok: true, op: 'processSweep', action: 'end', ended: true, road: 'daemon', reason: 'the daemon killed its released runner' }
  }
  return refuse('only a daemon or a runner takes the daemon road', 'none')
}
