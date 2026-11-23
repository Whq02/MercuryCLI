
import { randomUUID } from 'crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'path'
import { MERCURY_VERSION } from '../../platform/product/product.js'
import { describeArtifactIdentity } from '../../platform/product/artifactIdentity.js'
import { MERCURY_DAEMON_PROTO } from './protocol.js'
import { DaemonBreaker } from './daemonBreaker.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { localIpcDoorKind } from '../../platform/host-os/files.js'
import { processInstantStartForm } from '../../platform/host-os/processes.js'
import { sendPassedOverToDebugLog } from '../../platform/errors/passedOverSink.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { installStampedDaemonLog, stampDaemonLogLine } from './daemonLogStamp.js'
import { getRunTimeoutMs, scrubDaemonRoleEnv } from '../runner-link/headlessRun.js'
import {
  makeConcourseAdmitHandler,
  readSessionWorkers,
} from '../concourse-workers/concourseWorkers.js'
import {
  endRunnersLeftWithoutHost,
} from '../concourse-workers/concourseWorkers.js'
import { seatCeilingFactsAsync, serveHeldReadingFromBackground } from '../switchboard-capacity/capacityCheck.js'
import {
  onSeatSpawned,
  requestSessionFacts,
} from '../session-seat/sessionSeat.js'
import { resetSeatProjections } from '../../engine/connector/seatProjections.js'
import {
  claimWarmRunner,
  ensureWarmRunner,
  warmRunnerShorts,
} from '../runner-link/warmRunner.js'
import { reviveConcourseWorker } from '../concourse-workers/concourseWorkers.js'
import { readSessionWorkersSnapshot } from '../concourse-workers/concourseWorkers.js'
import { makeConcourseDispatchHandler, reconcileWorkingDispatches } from '../concourse-workers/concourseDispatch.js'
import type { TaskRoster } from '../roster/roster.js'
import {
  parseOwnerPid,
  isProcessAlive,
  getProcessStartInstant,
  getProcessStartInstantAsync,
  getProcessStartToken,
  getProcessStartTokenAsync,
} from './ownerWatch.js'
import { startControlServer } from './controlServer.js'
import { DAEMON_USAGE, parseDaemonVerb, daemonRecordIdentity } from './verbs.js'
import { hostedCallerOf, hostedCallerRefusalLine, restartEndsHostedCaller } from './hostedCaller.js'
import {
  acquireDaemonLock,
  clearDeadDaemonRecords,
  controlSockPath,
  currentVersion,
  daemonControlRpc,
  daemonDir,
  mintControlKey,
  readLiveControlKey,
  readDaemonState,
  daemonExitTeardownSync,
  daemonStatePath,
  writeDaemonState,
} from './controlSocket.js'
import { handoverState, parseHandoverFrom, predecessorSockPath, readHandoverHosts, renameSocketForPredecessor, type HandoverStateV1 } from './handover.js'
import { holdBuild, invokedScriptPath, selfScriptPath } from './daemonBuild.js'
import { decidePlaneBoot, type PlaneBootFactsV1 } from './planeBoot.js'
import { lockHeldByLivePidSync, readPlaneOwnerSync } from './planeRecords.js'
import { getMercuryDaemonStatus, formatMercuryDaemonStatus, helperPidsOfHome } from './status.js'
import { pollUntil } from '../../platform/async/deadline.js'
import { atBootStep, makeDaemonRunState, markDaemonReady } from '../run/state.js'
import { armHandoverBeats } from '../run/handover.js'
import { armPlaneHeal } from '../run/heal.js'
import { armOwnerWatch, makeSessionlessBeat, markHosted } from '../run/owner.js'
import { periodicArmer } from '../run/periodic.js'
import { armWaysOut, bindWayOut, giveHomeBack, shutdownDaemon } from '../run/shutdown.js'
import { armedRestartBeat, spawnSuccessorDaemon } from '../run/restart.js'
import { armReconcile } from '../run/sweep.js'
import { makeDaemonRoster } from '../run/roster.js'
import { armSaturn } from '../run/saturn.js'
import { controlServerDeps } from '../run/control.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { registerBootDoors } from '../../boot/doors/registerDoors.js'

function resolveDir(args: string[]): string {
  const arg = args.find(a => !a.startsWith('-'))
  return arg ? resolve(arg) : process.cwd()
}

function persistDaemonCrash(err: unknown, label: string): void {
  try {
    const crashMod = require('../../platform/logs/crashReport.js') as typeof import('../../platform/logs/crashReport.js')
    crashMod.persistCrashReport(err, undefined, label === 'uncaughtException' ? 'uncaught-exception' : 'unhandled-rejection')
  } catch (error) {
    passedOver(error)
  }
}


export async function daemonMain(args: string[]): Promise<void> {
  registerBootDoors()
  const verb = parseDaemonVerb(args)
  switch (verb.kind) {
    case 'status':
      return daemonStatusCmd()
    case 'stop':
      return daemonStopCmd()
    case 'restart':
      return daemonRestartCmd()
    case 'help':
      console.log(DAEMON_USAGE)
      return
    case 'unknown':
      console.error(`mercury daemon: unknown verb '${verb.word}'\n${DAEMON_USAGE}`)
      process.exitCode = 1
      return
    case 'unknown-flag':
      console.error(
        verb.verb === 'stop'
          ? `mercury daemon stop: unknown flag '${verb.word}' — stop takes no flags: it ends the daemon and every session process it runs (every worker) stops with it. Run \`mercury daemon stop\` bare, or \`mercury daemon restart\` to re-execute the daemon once its live sessions finish\n${DAEMON_USAGE}`
          : `mercury daemon ${verb.verb}: unknown flag '${verb.word}'\n${DAEMON_USAGE}`,
      )
      process.exitCode = 1
      return
    case 'run':
      return daemonRun(verb.args)
  }
}

async function daemonStatusCmd(): Promise<void> {
  const snapshot = await getMercuryDaemonStatus()
  console.log(formatMercuryDaemonStatus(snapshot))
}

async function daemonStopCmd(): Promise<void> {
  const hosting = await hostedCallerOf(await helperPidsOfHome())
  if (hosting.hosted) {
    console.error(hostedCallerRefusalLine('stop'))
    process.exitCode = 1
    return
  }
  const reply = await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 12_000 })
  if (reply.ok && reply.op === 'shutdown') {
    console.error(`[daemon] shutdown acknowledged — reaped ${reply.reaped} worker(s)`)
  } else if (!reply.ok && reply.code === 'ENOCONN') {
    const stale = await readDaemonState()
    if (stale && !isProcessAlive(stale.pid)) {
      await clearDeadDaemonRecords()
      console.error(`[daemon] no running daemon to stop — swept the stale record of pid ${stale.pid} (control socket unreachable, process gone)`)
    } else if (stale) {
      const verdict = daemonRecordIdentity(stale, stale.startToken ? getProcessStartToken(stale.pid, stale.startToken) : getProcessStartInstant(stale.pid))
      if (verdict === 'not-recorded-process') {
        await clearDeadDaemonRecords()
        console.error(`[daemon] no running daemon to stop — swept the stale record of pid ${stale.pid} (the pid was recycled: its live process is not the recorded daemon)`)
      } else if (verdict === 'same-process') {
        console.error(`[daemon] control socket unreachable but pid ${stale.pid} is alive and IS the recorded daemon — it may still be binding; retry in a moment, or end that process by hand`)
        process.exitCode = 1
      } else {
        console.error(`[daemon] control socket unreachable and pid ${stale.pid}'s identity could not be read — retry in a moment`)
        process.exitCode = 1
      }
    } else {
      const { probePidLock } = await import('../../platform/substrate/pidLock.js')
      const lockPath = join(daemonDir(), 'daemon.lock')
      const lockHolder = existsSync(lockPath) ? await probePidLock(lockPath, { liveness: 'assume-alive' }) : null
      if (existsSync(lockPath) && lockHolder === null) {
        await clearDeadDaemonRecords()
        console.error('[daemon] no running daemon to stop — swept a lock-only leftover (daemon.lock with no record, its holder gone or not the recorded process)')
      } else if (lockHolder !== null) {
        console.error(`[daemon] no running daemon to stop — but daemon.lock is held by live pid ${lockHolder.pid} with no record beside it; if that pid is not a Mercury daemon, end it and re-run, or remove ${lockPath} by hand`)
        process.exitCode = 1
      } else {
        console.error('[daemon] no running daemon to stop (control socket unreachable)')
      }
    }
  } else if (!reply.ok) {
    console.error(`[daemon] stop failed: ${reply.code} ${reply.error}`)
  }
}

async function daemonRestartCmd(): Promise<void> {
  const { handshakeDaemon, restartDaemon } = await import('./handshake.js')
  const first = await handshakeDaemon()
  const hosting = await hostedCallerOf(await helperPidsOfHome())
  if (hosting.hosted && first.daemon !== null && restartEndsHostedCaller(first)) {
    console.error(hostedCallerRefusalLine('restart'))
    process.exitCode = 1
    return
  }
  const receipt = await restartDaemon({ by: 'mercury daemon restart', posture: 'persistent' })
  const carried = hosting.hosted && receipt.state === 'armed' ? ' — this hosted session is one of them; your turn goes on' : ''
  console.error(`[daemon] ${receipt.line}${carried}`)
  if (receipt.state === 'refused') process.exitCode = 1
}


async function daemonRun(args: string[]): Promise<void> {
  const dir = resolveDir(args)
  const bootBuildTree = describeArtifactIdentity(currentVersion()).buildTree
  const bootScript = selfScriptPath()
  const buildHold = holdBuild()
  const foreground = process.stdout.isTTY === true || process.stderr.isTTY === true

  process.stderr.write(
    `${stampDaemonLogLine(`[mercury-daemon] engaged v${MERCURY_VERSION} pid ${process.pid} dir ${dir}`)}\n`,
  )
  if (!foreground) installStampedDaemonLog()
  console.error(`[daemon] build ${bootBuildTree ?? 'unstamped'} at ${bootScript || '?'} (${buildHold === 'held' ? 'the build folder is held open for the installer' : typeof buildHold === 'object' ? `the build folder could not be held open for the installer (${buildHold.unheld}), so it may be replaced while this daemon runs` : 'no manifest beside the bundle'})`)

  const scrubbed = scrubDaemonRoleEnv()
  if (scrubbed.length > 0) {
    logForDebugging(`[daemon] scrubbed inherited role env (daemon runs role-free): ${scrubbed.join(', ')}`)
  }
  const lockIdentity = `daemon-${randomUUID()}`

  const breaker = new DaemonBreaker()

  {
    const { runBootRecovery } = await import('../../platform/substrate/recoveryOrchestrator.js')
    const rec = await runBootRecovery({ scope: 'daemon', projectDir: dir })
    for (const err of rec.errors) logForDebugging(`[daemon] boot recovery: ${err}`)
  }
  try {
    const settledDispatches = reconcileWorkingDispatches()
    if (settledDispatches > 0) {
      logForDebugging(`[daemon] boot reconcile: settled ${settledDispatches} working dispatch row(s) whose worker had already ended`)
    }
  } catch (e) {
    logForDebugging(`[daemon] working-dispatch reconcile failed (non-fatal): ${e}`)
  }
  console.error(
    `[daemon] starting daemon for ${dir} ` +
      `(per-run cap ${Math.round(getRunTimeoutMs() / 60000)}m; ` +
      `circuit-breaker trips at ${breaker.getConsecutiveFailThreshold()} ` +
      `consecutive failures, ${Math.round(breaker.getCooldownMs() / 1000)}s cooldown; ` +
      `Ctrl-C to stop)`,
  )
  logForDebugging(`[daemon] starting — dir=${dir}, lockIdentity=${lockIdentity}`)
  sendPassedOverToDebugLog()

  const MAX_INFLIGHT = (() => {
    const n = parseInt(flagEnv('MERCURY_DAEMON_MAX_INFLIGHT') ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : 4
  })()

  const controlEnabled =
    !isEnvTruthy(flagEnv('MERCURY_DAEMON_CONTROL_DISABLED')) &&
    flagEnv('MERCURY_DAEMON_CONTROL') !== '0'

  let handoverPredecessor: number | null = null
  let handover: HandoverStateV1 | null = null
  let roster: TaskRoster | null = null
  const state = makeDaemonRunState({ dir, bootBuildTree, foreground, breaker, maxInflight: MAX_INFLIGHT, controlEnabled })
  const { persist, startedAt } = state
  const noteHosted = (): void => markHosted(state)
  const armPeriodic = periodicArmer(state)
  let requestShutdown: (signal: string) => void = signal => void (state.askedToLeave ??= signal)

  if (controlEnabled) {
    const successorOf = parseHandoverFrom(flagEnv('MERCURY_DAEMON_SUCCESSOR_OF'))
    const handoverFrom = parseHandoverFrom(flagEnv('MERCURY_DAEMON_HANDOVER_FROM'))
    const stamp = successorOf !== null ? `successor of pid ${successorOf}` : handoverFrom !== null ? `handover from pid ${handoverFrom}` : 'boot'
    const stamps = { selfBuildTree: bootBuildTree, successorOf, handoverFrom }
    const refuse = (why: string): void => {
      process.exitCode = 1
      console.error(`[daemon] ${stamp}: ${why} (${daemonDir()}) — refusing to start so the live one is not clobbered · ${FREE_THE_PLANE_WORDS}`)
    }
    let lastWait: Extract<ReturnType<typeof decidePlaneBoot>, { road: 'wait-lock' }> | undefined
    let decision: ReturnType<typeof decidePlaneBoot> = await pollUntil(
      async () => {
        const next = decidePlaneBoot(await planeBootFacts(stamps))
        if (next.road === 'wait-lock') {
          lastWait = next
          return undefined
        }
        return next
      },
      100,
      SUCCESSOR_LOCK_WAIT_MS,
      () => ({ road: 'refuse' as const, why: `the predecessor pid ${lastWait!.for} did not release the daemon lock within ${SUCCESSOR_LOCK_WAIT_MS / 1000}s` }),
    )
    if (decision.road === 'serve') {
      state.daemonLock = await acquireDaemonLock()
      if (!state.daemonLock) {
        decision = decidePlaneBoot(await planeBootFacts(stamps))
        if (decision.road !== 'handover') return refuse('the daemon lock was taken while this daemon booted')
      }
    }
    if (decision.road === 'handover') {
      handoverPredecessor = decision.from
      state.daemonLock = await acquireDaemonLock()
      console.error(`[daemon] ${stamp}: ${decision.why} — taking the plane${state.daemonLock ? '' : `; the daemon lock is taken when its holder leaves`}`)
    } else if (decision.road === 'serve') {
      if (successorOf !== null) {
        console.error(`[daemon] successor of pid ${successorOf} took the plane over (v${currentVersion()} proto ${MERCURY_DAEMON_PROTO})`)
      }
    } else if (decision.road === 'stand-down') {
      console.error(`[daemon] ${stamp}: ${decision.why} — standing down`)
      return
    } else {
      return refuse(decision.why)
    }
    process.once('exit', code => {
      if (!state.teardownComplete) daemonExitTeardownSync('exit-before-teardown', code)
    })
    try {
      await atBootStep(state, 'the seat ceiling')(seatCeilingFactsAsync())
      state.releaseHeldReading = serveHeldReadingFromBackground()
      roster = atBootStep(state, 'the roster')(makeDaemonRoster(state))
      state.roster = roster
      if (handoverPredecessor === null) resetSeatProjections(dir)
      const controlKey = atBootStep(state, 'the control key')(handoverPredecessor === null ? await mintControlKey() : ((await readLiveControlKey()) ?? (await mintControlKey())))
      const warmDeps = {
        roster: () => roster ?? undefined,
        onWarmSpawned: (short: string, workspaceId: string, pid: number | undefined) => {
          console.error(
            `[daemon] warm runner pre-spawned: ${short} (pid ${pid}) for ${workspaceId} — unclaimed, model-agnostic, no record`,
          )
        },
      }
      const warmAdmitDoors = {
        claimWarm: (args: Parameters<typeof claimWarmRunner>[0]) => claimWarmRunner(args, warmDeps),
        ensureWarm: (workspaceDir: string, kit?: Parameters<typeof ensureWarmRunner>[0]['kit'], bypassConsent?: boolean) => {
          void ensureWarmRunner({ workspaceDir, ...(kit !== undefined ? { kit } : {}), ...(bypassConsent === true ? { bypassConsent: true } : {}) }, warmDeps).catch(passedOver)
        },
      }
      const concourseDispatchHandler = makeConcourseDispatchHandler({
        admit: makeConcourseAdmitHandler({
          roster: () => roster ?? undefined,
          ...warmAdmitDoors,
          onSpawned: (runnerId, spec, pid) => {
            console.error(
              `[daemon] concourse worker admitted: ${runnerId} (pid ${pid}) — ${spec.model}@${spec.effort}, cwd ${spec.cwd}`,
            )
            noteHosted()
            if (roster !== null) onSeatSpawned(runnerId, roster)
          },
        }),
        deliver: async (runnerId, prompt) => {
          if (!roster) return false
          const delivered = await roster.reply(runnerId, prompt, 'confirm-written')
          if (delivered && runnerId.startsWith('concourse-w')) requestSessionFacts(runnerId, roster, { immediate: true })
          return delivered
        },
        revive: async sessionId => {
          const out = reviveConcourseWorker(sessionId, 'auto-revive', roster ?? undefined)
          if (out.outcome === 'applied' && roster !== null) onSeatSpawned(out.runnerId, roster)
          return out.outcome === 'applied' || out.outcome === 'noop'
            ? { ok: true }
            : { ok: false, error: out.detail ?? out.reason, reason: out.reason }
        },
      })
      const liveWorkers = (): { live: number; liveSessions: number } => {
        if (!roster) return { live: 0, liveSessions: 0 }
        const warm = new Set(warmRunnerShorts())
        let live = 0
        let liveSessions = 0
        for (const w of roster.liveWorkerFacts()) {
          if (warm.has(w.short)) continue
          live++
          if (w.short.startsWith('concourse-w')) liveSessions++
        }
        return { live, liveSessions }
      }
      const askLiveSessionsForFacts = (): number => {
        if (!roster) return 0
        const warm = new Set(warmRunnerShorts())
        let asked = 0
        for (const w of roster.liveWorkerFacts()) {
          if (warm.has(w.short) || !w.short.startsWith('concourse-w')) continue
          requestSessionFacts(w.short, roster, { immediate: true })
          asked++
        }
        return asked
      }
      const restartNeeds = { liveWorkers, askLiveSessionsForFacts, requestShutdown: (signal: string) => requestShutdown(signal) }
      const bootStartToken = await atBootStep(state, 'the start token')(getProcessStartTokenAsync(process.pid))
      const bootStartInstant = processInstantStartForm() === 'instant' ? await getProcessStartInstantAsync(process.pid) : bootStartToken
      const persistDaemonRecord = (owner: number | null): Promise<void> =>
        writeDaemonState({
          pid: process.pid,
          version: currentVersion(),
          origin: 'transient',
          startedAt,
          dir,
          controlSock: controlSockPath(),
          proto: MERCURY_DAEMON_PROTO,
          buildTree: bootBuildTree,
          script: invokedScriptPath(),
          ownerPid: owner,
          foreground,
          startToken: bootStartToken,
          ...(bootStartInstant && bootStartInstant !== bootStartToken ? { startInstant: bootStartInstant } : {}),
          persist,
        })
      if (handoverPredecessor !== null) {
        const rosterRef = roster
        handover = handoverState(
          handoverPredecessor,
          short => rosterRef?.has(short).present ?? false,
          () => Object.values(readSessionWorkersSnapshot().state === 'known' ? readSessionWorkers() : {}),
          await atBootStep(state, 'the handover take')(readHandoverHosts(handoverPredecessor, controlKey)),
        )
        state.handover = handover
        await persistDaemonRecord(state.currentOwnerPid)
        const moved = renameSocketForPredecessor(handoverPredecessor)
        handover.notePlaneMoved()
        const held = handover.heldRunners(handoverPredecessor).size
        console.error(`[daemon] handover from pid ${handoverPredecessor}: took the plane (v${currentVersion()} proto ${MERCURY_DAEMON_PROTO}); its socket ${moved ? `serves on at ${handover.sockPath}` : 'was not on the path'}; ${held > 0 ? `it keeps ${held} live session(s) until they finish` : 'it holds no live session — it leaves on its own, or is asked to once it reads idle'}`)
      }
      const handoverRef = handover
      {
        const rosterRef = roster
        const left = await atBootStep(state, 'the runners left without a host')(endRunnersLeftWithoutHost(short => (rosterRef?.has(short).present ?? false) || (handoverRef?.holds(short) ?? false)))
        if (left.length > 0) {
          console.error(`[daemon] ${left.length} runner${left.length === 1 ? '' : 's'} left by a daemon that died ${left.length === 1 ? 'was' : 'were'} ended: ${left.map(r => `${r.runnerId} (pid ${r.pid})`).join(', ')}; each session answers its next message on a fresh runner`)
          try {
            reconcileWorkingDispatches()
          } catch (e) {
            logForDebugging(`[daemon] working-dispatch reconcile after the left runners failed (non-fatal): ${e}`)
          }
        }
      }
      const countBirth = async <T>(door: () => Promise<T>): Promise<T> => {
        state.birthsInFlight++
        try {
          return await door()
        } finally {
          state.birthsInFlight--
        }
      }
      const concourseAdmitHandler = makeConcourseAdmitHandler({
        roster: () => roster ?? undefined,
        ...warmAdmitDoors,
        onSpawned: (runnerId, spec, pid) => {
          console.error(
            `[daemon] concourse worker admitted: ${runnerId} (pid ${pid}) — ${spec.model}@${spec.effort}, cwd ${spec.cwd}`,
          )
          noteHosted()
          if (roster !== null) onSeatSpawned(runnerId, roster)
        },
      })
      state.controlServer = await atBootStep(state, 'the control server')(startControlServer(controlServerDeps(state, { roster, handover, handoverRef, controlKey, countBirth, concourseAdmitHandler, concourseDispatchHandler, warmDeps, liveWorkers, requestShutdown: (signal: string) => requestShutdown(signal), restartNeeds, bootStartInstant }), { socketPath: localIpcDoorKind() === 'named-pipe' ? controlSockPath() : predecessorSockPath(process.pid) }))
      await atBootStep(state, 'the daemon record')(persistDaemonRecord(state.currentOwnerPid))
      armPlaneHeal(state, {
        controlKey,
        persistDaemonRecord,
        askLiveSessionsForFacts,
        armPeriodic,
      })
      armPeriodic('the armed-restart beat', () => armedRestartBeat(state, restartNeeds))
      armPeriodic('the sessionless beat', makeSessionlessBeat(state, { liveWorkers, requestShutdown: signal => requestShutdown(signal) }))
      armHandoverBeats(state, { handoverPredecessor, armPeriodic })
      const { startHostJobSweep } = await atBootStep(state, 'the host job sweep')(import('../../models/hosting/jobs.js'))
      state.stopHostJobs = startHostJobSweep()
      markDaemonReady(state)
      console.error('[daemon] control socket up — RPC: list/has/status/dispatch/reply/kill/shutdown')
      armSaturn(state, { concourseDispatchHandler, warmAdmitDoors })
      if (parseOwnerPid() !== null && flagEnv('MERCURY_DAEMON_NO_SELF_WARM') !== '1') {
        void ensureWarmRunner({ workspaceDir: dir, ...(flagEnv('MERCURY_DAEMON_SELF_WARM_CONSENT') === '1' ? { bypassConsent: true } : {}) }, warmDeps)
          .then(w => {
            if (w.state === 'refused') {
              console.error(`[daemon] boot self-warm refused — ${w.detail ?? 'unspecified'} (the first dispatch spawns cold)`)
            }
          })
          .catch(e => logForDebugging(`[daemon] boot self-warm failed (the first dispatch spawns cold): ${e}`))
      }
      armReconcile(state, { warmDeps, armPeriodic })
    } catch (e) {
      roster = null
      state.roster = roster
      await giveHomeBack(state, { planeAnswer, planeHeldLine }, e)
    }
  }

  return new Promise<void>(resolveShutdown => {
    const keepAlive = armPeriodic('the keep-alive', () => {})
    const wayOut = { keepAlive, resolveShutdown, spawnSuccessorDaemon }
    const shutdown = (signal: string): void => shutdownDaemon(state, wayOut, signal)
    const ownerNeeds = { shutdown }
    requestShutdown = bindWayOut(state, shutdown)
    armWaysOut({ shutdown, persistCrash: persistDaemonCrash })
    if (state.currentOwnerPid !== null && !persist) {
      void armOwnerWatch(state, ownerNeeds, state.currentOwnerPid, true)
    }
  })
}

const SUCCESSOR_LOCK_WAIT_MS = 10_000

export const FREE_THE_PLANE_WORDS = '`mercury daemon stop` asks the daemon that holds this home to leave (it answers over the control pipe from any Mercury build); if it does not answer, end its pid by hand, then start again'

function planeHeldLine(holder: { pid: number; buildTree: string | null } | null, plane: string = controlSockPath(), stateFile: string = daemonStatePath()): string {
  const door = localIpcDoorKind() === 'named-pipe' ? 'control pipe' : 'control socket'
  if (holder !== null && holder.pid === process.pid) return `this daemon gives the home back and exits: no other daemon holds the ${door} ${plane} — start again`
  if (holder !== null) {
    return `this daemon gives the home back and exits: pid ${holder.pid} (build ${holder.buildTree ?? 'unstamped'}) holds the ${door} ${plane} — ${FREE_THE_PLANE_WORDS}`
  }
  return `this daemon gives the home back and exits: the ${door} ${plane} is held by a process that does not answer — end it by hand (the pid in ${stateFile}, when it names one), then start again`
}

async function planeAnswer(bootBuildTree: string | null): Promise<{ pid: number; buildTree: string | null } | null> {
  const reply = await daemonControlRpc(
    { op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: currentVersion(), clientBuildTree: bootBuildTree },
    { timeoutMs: 1500, protoRetry: false },
  )
  if (reply.ok && reply.op === 'hello' && typeof reply.pid === 'number') return { pid: reply.pid, buildTree: reply.buildTree }
  return null
}

async function planeBootFacts(stamps: { selfBuildTree: string | null; successorOf: number | null; handoverFrom: number | null }): Promise<PlaneBootFactsV1> {
  const owner = readPlaneOwnerSync()
  return {
    selfPid: process.pid,
    selfBuildTree: stamps.selfBuildTree,
    successorOf: stamps.successorOf,
    handoverFrom: stamps.handoverFrom,
    lockHolder: lockHeldByLivePidSync(),
    record: owner !== null && owner.alive ? { pid: owner.pid, buildTree: owner.buildTree } : null,
    plane: await planeAnswer(stamps.selfBuildTree),
  }
}
