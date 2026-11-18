
import { randomUUID } from 'crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'path'
import { MERCURY_VERSION } from '../constants/product.js'
import { describeArtifactIdentity } from '../utils/artifactIdentity.js'
import { MERCURY_DAEMON_PROTO } from './protocol.js'
import { DaemonBreaker } from '../utils/daemonBreaker.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { installStampedDaemonLog, stampDaemonLogLine } from './daemonLogStamp.js'
import { getRunTimeoutMs, scrubDaemonRoleEnv } from './headlessRun.js'
import {
  listConcourseWorkers,
  makeConcourseAdmitHandler,
  pauseConcourseWorker,
  readSessionWorkers,
  resumeConcourseWorker,
  settleConcourseWorker,
} from './concourseWorkers.js'
import {
  attachYieldConcourseSession,
  blurConcourseSession,
  completeRequestedPark,
  endRunnersLeftWithoutHost,
  retireRequestedPark,
  detachRespawnConcourseSession,
  focusConcourseSession,
  grantConcourseWorkflows,
  isNewbornRecord,
  parkAllConcourseSessions,
  parkConcourseSession,
  retireConcourseSession,
  revokeConcourseWorkflows,
  turnInFlightOf,
  workerPidAlive,
} from './concourseWorkers.js'
import { answerPermissionAsk, holdWorkerAsk } from './permissionAsks.js'
import { seatCeilingFactsAsync, serveHeldReadingFromBackground } from '../services/switchboard/capacityCheck.js'
import {
  onSeatIdle,
  controlSessionAgent,
  onSeatApplied,
  answerSeatScheduleEdit,
  applySeatScheduleControl,
  onSeatRow,
  onSeatSpawned,
  publishSeatFacts,
  pushScheduleRosterForSession,
  refreshSessionFacts,
  requestSessionFacts,
  rewindSession,
  setSessionEffort,
  setSessionKitDial,
  actOnSessionMcp,
  listSessionMcpTools,
  setSessionModel,
  setSessionPermissionMode,
  setSessionSpawnSwitch,
  withdrawSessionSend,
  relayCredentialChange,
  backgroundSessionShell,
  sendSessionNow,
  pauseSessionGate,
  postSessionBoard,
  leaveSession,
} from './sessionSeat.js'
import { resetSeatProjections } from '../services/engine-connector/seatProjections.js'
import {
  claimWarmRunner,
  ensureWarmRunner,
  warmRunnerCount,
  warmRunnerShorts,
} from './warmRunner.js'
import { stopConcourseSession, reviveConcourseWorker, setConcourseSessionTitle } from './concourseWorkers.js'
import { readSessionWorkersSnapshot } from './concourseWorkers.js'
import { applyConcourseContractOp } from './sessionContract.js'
import { dropSaturnSelfWakes, type SaturnSelfWakeDropWhy } from './saturn.js'
import { deriveScheduleAccountForModel, liveFactsForSessionFire } from './saturnAccount.js'
import { composeSignInView, refreshSignInReads } from './signInView.js'
import { startSaturnTicker } from './saturnTicker.js'
import { makeSaturnBirthPort } from './saturnBirth.js'
import { makeConcourseDispatchHandler, readConcourseControlOps, recordConcourseControlOp, buildConcoursePromptRow, failWorkingDispatchesForRunner, heldGitLaunchesFor, reconcileWorkingDispatches, replayGitBlockedDispatches, denyProceedLaunchesFor, replayDenyProceedDispatches } from './concourseDispatch.js'
import { TaskRoster } from './roster.js'
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
  readControlKey,
  readDaemonState,
  daemonExitTeardownSync,
  daemonStatePath,
  writeDaemonState,
} from './controlSocket.js'
import { handoverRoadOf, handoverState, parseHandoverFrom, predecessorSockPath, readHandoverHosts, renameSocketForPredecessor, type HandoverStateV1 } from './handover.js'
import { holdBuild, invokedScriptPath, selfScriptPath } from './daemonBuild.js'
import { decidePlaneBoot, type PlaneBootFactsV1 } from './planeBoot.js'
import { lockHeldByLivePidSync, readPlaneOwnerSync } from './planeRecords.js'
import { getMercuryDaemonStatus, formatMercuryDaemonStatus, helperPidsOfHome } from './status.js'
import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { sleep } from '../utils/sleep.js'
import { makeDaemonRunState, markDaemonReady } from './run/state.js'
import { armHandoverBeats } from './run/handover.js'
import { armPlaneHeal } from './run/heal.js'
import { armOwnerWatch, makeSessionlessBeat, markHosted } from './run/owner.js'
import { periodicArmer } from './run/periodic.js'
import { armWaysOut, bindWayOut, giveHomeBack, shutdownDaemon, stopVerb } from './run/shutdown.js'
import { armedRestartBeat, restartWhenIdle, spawnSuccessorDaemon } from './run/restart.js'
import { armReconcile, processSweep } from './run/sweep.js'

function resolveDir(args: string[]): string {
  const arg = args.find(a => !a.startsWith('-'))
  return arg ? resolve(arg) : process.cwd()
}

function persistDaemonCrash(err: unknown, label: string): void {
  try {
    const crashMod = require('../utils/crashReport.js') as typeof import('../utils/crashReport.js')
    crashMod.persistCrashReport(err, undefined, label === 'uncaughtException' ? 'uncaught-exception' : 'unhandled-rejection')
  } catch {
  }
}

function dropSelfWakesAtFlip(sessionId: string, by: string, why: SaturnSelfWakeDropWhy, roster: TaskRoster | null = null): void {
  try {
    const gone = dropSaturnSelfWakes(sessionId, by, why)
    if (gone.dropped.length > 0) {
      console.error(
        `[daemon] ${sessionId}: ${gone.dropped.length} self-paced wake${gone.dropped.length === 1 ? '' : 's'} dropped (${why}) — ${gone.dropped.join(', ')}${gone.droppedHolds > 0 ? `, ${gone.droppedHolds} held fire${gone.droppedHolds === 1 ? '' : 's'} with ${gone.dropped.length === 1 ? 'it' : 'them'}` : ''}`,
      )
      if (roster !== null) pushScheduleRosterForSession(sessionId, roster)
    }
  } catch (err) {
    logForDebugging(`[daemon] ${sessionId}: self-paced wake drop (${why}) failed — ${err instanceof Error ? err.message : String(err)}; the ticker converges it`)
  }
}


export async function daemonMain(args: string[]): Promise<void> {
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
      const { probePidLock } = await import('../substrate/pidLock.js')
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
  console.error(`[daemon] build ${bootBuildTree ?? 'unstamped'} at ${bootScript || '?'} (${buildHold === 'held' ? 'the build folder is held open for the installer' : 'no manifest beside the bundle'})`)

  const scrubbed = scrubDaemonRoleEnv()
  if (scrubbed.length > 0) {
    logForDebugging(`[daemon] scrubbed inherited role env (daemon runs role-free): ${scrubbed.join(', ')}`)
  }
  const lockIdentity = `daemon-${randomUUID()}`

  const breaker = new DaemonBreaker()

  {
    const { runBootRecovery } = await import('../substrate/recoveryOrchestrator.js')
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
  const { persist, readyPromise, startedAt } = state
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
    let decision = decidePlaneBoot(await planeBootFacts(stamps))
    if (decision.road === 'wait-lock') {
      const deadline = Date.now() + SUCCESSOR_LOCK_WAIT_MS
      while (decision.road === 'wait-lock' && Date.now() < deadline) {
        await sleep(100)
        decision = decidePlaneBoot(await planeBootFacts(stamps))
      }
      if (decision.road === 'wait-lock') decision = { road: 'refuse', why: `the predecessor pid ${decision.for} did not release the daemon lock within ${SUCCESSOR_LOCK_WAIT_MS / 1000}s` }
    }
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
      await seatCeilingFactsAsync()
      state.releaseHeldReading = serveHeldReadingFromBackground()
      roster = new TaskRoster({
        dir,
        breaker,
        maxInflight: MAX_INFLIGHT,
        onAsk: (short, params) => holdWorkerAsk(short, params),
        onRow: (short, row) => {
          if (!short.startsWith('concourse-w') || roster === null) return
          onSeatRow(short, row, roster)
        },
        onApplied: (short, params) => {
          if (!short.startsWith('concourse-w') || roster === null) return
          onSeatApplied(short, params, roster)
        },
        onScheduleEdit: (short, params) => {
          if (!short.startsWith('concourse-w') || roster === null) return { outcome: 'refused', detail: 'unknown-session: no live worker record owns this session' }
          return answerSeatScheduleEdit(short, params, roster)
        },
        onChildRelaunched: short => {
          if (!short.startsWith('concourse-w') || roster === null) return
          onSeatSpawned(short, roster)
        },
        onChildReady: short => {
          if (!short.startsWith('concourse-w') || roster === null) return
          publishSeatFacts(short, undefined, roster)
          requestSessionFacts(short, roster, { immediate: true })
        },
        onChildCrashed: short => {
          if (!short.startsWith('concourse-w') || roster === null) return
          publishSeatFacts(short, undefined, roster)
        },
        onDegraded: (reason, short) => {
          console.error(`[daemon] ${GLYPH.warn} DAEMON DEGRADED — ${reason}`)
          if (short !== undefined && short.startsWith('concourse-w')) {
            try {
              settleConcourseWorker(short)
            } catch {
            }
            try {
              failWorkingDispatchesForRunner(short, reason)
            } catch {
            }
          }
        },
        onIdle: short => {
          if (short.startsWith('concourse-w') && roster !== null) {
            const parkedWords = `[daemon] ${short} finished its turn and parked (a park was requested while it worked)`
            if (completeRequestedPark(short, roster)) {
              console.error(parkedWords)
            } else {
              void retireRequestedPark(short, roster)
                .then(parked => {
                  if (parked) console.error(parkedWords)
                })
                .catch(e => logForDebugging(`[daemon] ${short}: the requested park's retirement threw (ignored): ${e}`))
            }
            onSeatIdle(short, roster)
          }
        },
      })
      state.roster = roster
      if (handoverPredecessor === null) resetSeatProjections(dir)
      const controlKey = handoverPredecessor === null ? await mintControlKey() : ((await readControlKey()) ?? (await mintControlKey()))
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
          void ensureWarmRunner({ workspaceDir, ...(kit !== undefined ? { kit } : {}), ...(bypassConsent === true ? { bypassConsent: true } : {}) }, warmDeps).catch(() => {})
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
          const delivered = await roster.reply(runnerId, prompt)
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
      const bootStartToken = await getProcessStartTokenAsync(process.pid)
      const bootStartInstant = process.platform === 'win32' ? await getProcessStartInstantAsync(process.pid) : bootStartToken
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
          await readHandoverHosts(handoverPredecessor, controlKey),
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
        const left = await endRunnersLeftWithoutHost(short => (rosterRef?.has(short).present ?? false) || (handoverRef?.holds(short) ?? false))
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
      state.controlServer = await startControlServer({
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
          if (!roster) return []
          const entries = roster.list().filter(j => !j.outcome)
          const live = new Set([...entries.map(j => j.short), ...(handover?.heldRunners() ?? [])])
          const livePid = new Map(entries.map(j => [j.short, j.pid]))
          return listConcourseWorkers(live).map(r => ({
            ...r,
            workerId: r.runnerId,
            ...(livePid.get(r.runnerId) !== undefined ? { pid: livePid.get(r.runnerId) } : {}),
          })) as unknown as ReadonlyArray<Record<string, unknown>>
        },
        concourseRelease: runnerId => {
          const killed = roster ? roster.kill(runnerId) : false
          if (!killed) {
            const rec = readSessionWorkers()[runnerId]
            if (rec?.endedAt === undefined && rec?.pid !== undefined && isProcessAlive(rec.pid)) {
              return { settled: false, killed: false }
            }
          }
          const settled = settleConcourseWorker(runnerId)
          const reap = (delayMs: number): void => {
            const t = setTimeout(() => {
              const r = roster
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
          if (roster === null) return { outcome: 'refused' as const, mode: 'code' as const, refusal: 'no-channel' as const, detail: 'daemon roster not ready' }
          return rewindSession(req.sessionId, { mode: 'code', userMessageId: req.userMessageId }, roster, undefined, { fileRestore: req })
        },
        sessionRewind: async req => {
          if (roster === null) {
            return { outcome: 'refused' as const, mode: req.mode, refusal: 'no-channel' as const, detail: 'daemon roster not ready' }
          }
          return rewindSession(req.sessionId, { mode: req.mode, userMessageId: req.userMessageId, ...(req.dryRun === true ? { dryRun: true } : {}) }, roster)
        },
        concourseControl: async ({ action, sessionId, by, reason, hard, requestId, allow, answer, model, words, effort, mode, contract, kitEdit, mcpAction, mcpServer, scheduleEdit, spawnSwitch, terminalApplication, clientOpId, mintedAtMs, title, titleSource, agentId, note, clientMessageId, paused, boardPost }) => {
          void reason
          if (clientOpId !== undefined) {
            const prior = readConcourseControlOps()[clientOpId]
            if (prior && prior.action === action && prior.sessionId === sessionId)
              return { outcome: prior.outcome, ...(prior.detail !== undefined ? { detail: prior.detail } : {}) }
          }
          const settle = (r: { outcome: 'applied' | 'noop' | 'refused'; detail?: string }): typeof r => {
            if (clientOpId !== undefined) {
              try {
                recordConcourseControlOp({ clientOpId, action, sessionId, outcome: r.outcome, ...(r.detail !== undefined ? { detail: r.detail } : {}), atMs: Date.now() })
              } catch (e) {
                logForDebugging(
                  `[daemon] concourse-control: applied-ops ledger write failed (${e instanceof Error ? e.message : String(e)}) — receipt returned unrecorded`,
                )
              }
            }
            return r
          }
          if (action === 'answer-permission') {
            if (requestId === undefined || requestId === '') {
              return { outcome: 'refused' as const, detail: 'answer-permission requires requestId' }
            }
            return answerPermissionAsk(
              requestId,
              allow === true,
              by,
              {
                onGitReady: folder => {
                  const waiting = heldGitLaunchesFor(folder)
                  void replayGitBlockedDispatches(folder, concourseDispatchHandler)
                    .then(rows => {
                      for (const row of rows) {
                        console.error(
                          `[daemon] git-ready replay ${row.clientMessageId} (${row.title ?? 'untitled'}): ${row.ok ? `started as ${row.sessionId ?? '?'}${row.branchName !== undefined ? ` on ${row.branchName}` : ''}` : row.error ?? 'still held'}`,
                        )
                      }
                    })
                    .catch(err => logForDebugging(`[daemon] git-ready replay failed for ${folder}: ${err}`))
                  return waiting
                },
                onDenyProceed: folder => {
                  const proceeding = denyProceedLaunchesFor(folder)
                  if (proceeding.length > 0) {
                    void replayDenyProceedDispatches(folder, concourseDispatchHandler)
                      .then(rows => {
                        for (const row of rows) {
                          console.error(
                            `[daemon] deny-proceed replay ${row.clientMessageId} (${row.title ?? 'untitled'}): ${row.ok ? `started as ${row.sessionId ?? '?'} — in the folder as it is, alone` : row.error ?? 'still held'}`,
                          )
                        }
                      })
                      .catch(err => logForDebugging(`[daemon] deny-proceed replay failed for ${folder}: ${err}`))
                  }
                  return proceeding
                },
              },
              answer as Parameters<typeof answerPermissionAsk>[4],
            )
          }
          if (action === 'park-all') {
            const all = parkAllConcourseSessions(by, roster ?? undefined, undefined, {
              reason: undefined,
              exceptFocusedByLiveTerminal: true,
            })
            console.error(
              `[daemon] park-all by ${by}: parked ${all.parked.length}, draining ${all.draining.length}, released ${all.released.length} newborn(s), skipped ${all.skipped.length}${all.refused.length > 0 ? `, refused ${all.refused.join(', ')}` : ''}`,
            )
            return {
              outcome: 'applied' as const,
              detail: `parked ${all.parked.join(', ') || '-'} · draining ${all.draining.join(', ') || '-'} · released ${all.released.join(', ') || '-'} · skipped ${all.skipped.join(', ') || '-'}`,
            }
          }
          const rec = Object.values(readSessionWorkers()).find(
            r => r.sessionId === sessionId && r.endedAt === undefined,
          )
          if (!rec) return settle({ outcome: 'refused' as const, detail: 'unknown-session: no live worker record owns this session' })
          if (action === 'park') {
            if (roster && rec.pid !== undefined && !isNewbornRecord(rec) && !turnInFlightOf(rec) && workerPidAlive(rec) && rec.attachedAt === undefined) {
              const retired = await retireConcourseSession(sessionId, by, roster)
              return retired.outcome === 'parked'
                ? { outcome: 'applied' as const, detail: `parked ${retired.runnerId}` }
                : { outcome: 'refused' as const, detail: `${retired.runnerId ?? rec.runnerId}: ${retired.reason}` }
            }
            const out = parkConcourseSession(sessionId, by, roster ?? undefined)
            return out.outcome === 'refused'
              ? { outcome: 'refused' as const, detail: out.detail ?? out.reason }
              : out.outcome === 'noop'
                ? { outcome: 'noop' as const, detail: out.reason }
                : out.outcome === 'draining'
                  ? { outcome: 'draining' as const, detail: `${out.runnerId} finishes its turn, then parks` }
                  : { outcome: 'applied' as const, detail: out.released ? `released newborn ${out.runnerId}` : `parked ${out.runnerId}` }
          }
          if (action === 'set-title') {
            return settle(setConcourseSessionTitle(sessionId, title ?? '', by, titleSource === 'minted' ? 'minted' : 'operator'))
          }
          if (action === 'contract') {
            if (contract === undefined) return { outcome: 'refused' as const, detail: 'contract requires { contract: { op, text? } }' }
            return settle(applyConcourseContractOp(sessionId, contract, by))
          }
          if (action === 'set-schedule') {
            if (scheduleEdit === undefined) return { outcome: 'refused' as const, detail: 'set-schedule requires { scheduleEdit: { op, schedule? | scheduleId? } }' }
            return settle(applySeatScheduleControl(sessionId, scheduleEdit, by, roster))
          }
          if (action === 'mcp-action') {
            if (!mcpAction || !roster) return { outcome: 'refused' as const, detail: 'the MCP action or runner is unavailable' }
            return actOnSessionMcp(sessionId, mcpAction, roster)
          }
          if (action === 'mcp-tools') {
            if (!mcpServer || !roster) return { outcome: 'refused' as const, detail: 'the MCP server or runner is unavailable' }
            return listSessionMcpTools(sessionId, mcpServer, roster)
          }
          if (action === 'set-kit') {
            if (kitEdit === undefined) return { outcome: 'refused' as const, detail: 'set-kit requires { kitEdit: { mcp?, skills?, extensions? } }' }
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            const dialed = setSessionKitDial(sessionId, kitEdit, by, roster)
            return dialed.outcome === 'queued'
              ? dialed
              : settle({ outcome: dialed.outcome, ...(dialed.detail !== undefined ? { detail: dialed.detail } : {}) })
          }
          if (action === 'set-model') {
            if (model === undefined || model === '') return { outcome: 'refused' as const, detail: 'set-model requires model' }
            return roster !== null ? await setSessionModel(sessionId, model, roster, undefined, words) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-effort') {
            if (effort === undefined || effort === '') return { outcome: 'refused' as const, detail: 'set-effort requires effort' }
            return roster !== null ? setSessionEffort(sessionId, effort, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-spawn-switch') {
            if (spawnSwitch === undefined) return { outcome: 'refused' as const, detail: 'set-spawn-switch requires { spawnSwitch: { kind: subagents|workflows, on } }' }
            if (spawnSwitch.kind === 'workflows') return { outcome: 'noop' as const }
            return roster !== null ? setSessionSpawnSwitch(sessionId, { kind: spawnSwitch.kind, on: spawnSwitch.on }, by, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-permission-mode') {
            if (mode === undefined || mode === '') return { outcome: 'refused' as const, detail: 'set-permission-mode requires mode' }
            return roster !== null ? setSessionPermissionMode(sessionId, mode, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'session-facts') {
            return roster !== null ? refreshSessionFacts(sessionId, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'focus' || action === 'blur') {
            const out = action === 'focus' ? focusConcourseSession(sessionId, by, undefined, terminalApplication) : blurConcourseSession(sessionId, by)
            if (out.outcome === 'applied') {
              const left = action === 'focus' && out.cleared.length > 0 ? ` — seat left ${out.cleared.join(', ')}` : ''
              return { outcome: 'applied' as const, detail: `${action} ${out.runnerId}${left}` }
            }
            return out.outcome === 'noop'
              ? { outcome: 'noop' as const, detail: out.reason }
              : { outcome: 'refused' as const, detail: out.reason }
          }
          if (action === 'interrupt') {
            const door = roster?.door(rec.runnerId)
            if (door === undefined) return settle({ outcome: 'refused' as const, detail: 'worker has no live runner door' })
            if (door.closed) return settle({ outcome: 'refused' as const, detail: 'the interrupt did not reach the runner: its door is closed' })
            const sent = door.send('turn/interrupt', { ...(clientOpId !== undefined ? { op_id: `concourse-interrupt-${clientOpId}` } : {}), ...(hard === true ? { hard: true } : {}) })
            sent.answer.catch(() => undefined)
            dropSelfWakesAtFlip(sessionId, by, 'interrupted', roster)
            return settle({ outcome: 'applied' as const, detail: `${hard === true ? 'second interrupt' : 'interrupt'} ${rec.runnerId}` })
          }
          if (action === 'stop-agent' || action === 'resume-agent') {
            if (agentId === undefined || agentId === '') return { outcome: 'refused' as const, detail: `${action} requires agentId` }
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            return controlSessionAgent(sessionId, agentId, action, roster, undefined, note !== undefined ? { note } : undefined)
          }
          if (action === 'withdraw-send') {
            if (clientMessageId === undefined || clientMessageId === '') return { outcome: 'refused' as const, detail: 'withdraw-send requires clientMessageId' }
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            return withdrawSessionSend(sessionId, clientMessageId, roster)
          }
          if (action === 'background-shell') {
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            return backgroundSessionShell(sessionId, roster)
          }
          if (action === 'send-now') {
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            return sendSessionNow(sessionId, roster)
          }
          if (action === 'board-post') {
            if (boardPost === undefined) return { outcome: 'refused' as const, detail: 'board-post requires { boardPost: { clientOpId, channel, target?, text } }' }
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            return postSessionBoard(sessionId, boardPost, roster)
          }
          if (action === 'pause-gate') {
            if (typeof paused !== 'boolean') return { outcome: 'refused' as const, detail: 'pause-gate requires paused' }
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            return pauseSessionGate(sessionId, paused, roster)
          }
          if (action === 'leave') {
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            return leaveSession(sessionId, roster)
          }
          if (action === 'stop') {
            roster?.door(rec.runnerId)?.request('turn/interrupt', { hard: true }).catch(() => {})
            const out = stopConcourseSession(sessionId, by, roster ?? undefined)
            if (out.outcome === 'applied') dropSelfWakesAtFlip(sessionId, by, 'stopped')
            return out.outcome === 'refused'
              ? { outcome: 'refused' as const, detail: out.reason }
              : out.outcome === 'noop'
                ? { outcome: 'noop' as const, detail: out.reason }
                : out.acknowledged
                  ? { outcome: 'applied' as const, detail: `stopped ${out.runnerId}` }
                  : { outcome: 'applied' as const, detail: `stop sent — ${out.runnerId} ends its turn and its crewmates; the row reads stopped once it is gone` }
          }
          if (action === 'attach') {
            const out = attachYieldConcourseSession(sessionId, by, roster ?? undefined)
            return out.outcome === 'refused'
              ? { outcome: 'refused' as const, detail: out.detail ?? out.reason }
              : { outcome: out.outcome, detail: out.runnerId }
          }
          if (action === 'detach') {
            const out = detachRespawnConcourseSession(sessionId, by, roster ?? undefined, undefined, {
              ...(mintedAtMs !== undefined ? { mintedAtMs } : {}),
            })
            return out.outcome === 'applied'
              ? {
                  outcome: 'applied' as const,
                  detail: `${out.runnerId}${out.pid !== undefined ? ` pid ${out.pid}` : ''}`,
                }
              : out.outcome === 'noop'
                ? { outcome: 'noop' as const, detail: out.reason }
                : { outcome: 'refused' as const, detail: out.detail ?? out.reason }
          }
          if (action === 'grant-workflows' || action === 'revoke-workflows') {
            const out =
              action === 'grant-workflows'
                ? grantConcourseWorkflows(sessionId, by)
                : revokeConcourseWorkflows(sessionId, by)
            if (action === 'grant-workflows' && out.outcome === 'applied' && roster !== null) {
              const r = roster
              void buildConcoursePromptRow(
                '[switchboard notice] The crewmates-allowed tag just landed on this session — crewmates are available from your next turn. Automated notice; no reply needed.',
              )
                .then(row => r.reply(rec.runnerId, row))
                .catch(() => {})
            }
            return out.outcome === 'applied'
              ? { outcome: 'applied' as const, detail: `${action} ${rec.runnerId}` }
              : out.outcome === 'noop'
                ? { outcome: 'noop' as const, detail: out.reason }
                : {
                    outcome: 'refused' as const,
                    detail: out.reason === 'cap-one' && out.detail !== undefined ? out.detail : out.reason,
                  }
          }
          if (action === 'pause') {
            const out = pauseConcourseWorker(rec.runnerId, by)
            return settle(
              out.outcome === 'applied'
                ? { outcome: 'applied' as const, detail: `pause ${rec.runnerId}` }
                : { outcome: out.outcome, detail: out.reason },
            )
          }
          const out = resumeConcourseWorker(rec.runnerId, by)
          if (out.outcome === 'refused') return settle({ outcome: 'refused' as const, detail: out.reason })
          const fresh = Object.values(readSessionWorkers()).find(
            r => r.sessionId === sessionId && r.endedAt === undefined,
          )
          if (
            fresh &&
            fresh.attachedAt === undefined &&
            (fresh.pid === undefined || !isProcessAlive(fresh.pid))
          ) {
            const rev = reviveConcourseWorker(sessionId, by, roster ?? undefined, { allowStopped: true })
            if (rev.outcome === 'applied' && roster !== null) onSeatSpawned(rev.runnerId, roster)
            return settle(
              rev.outcome === 'applied'
                ? {
                    outcome: 'applied' as const,
                    detail: `resume ${rec.runnerId} — revived${rev.pid !== undefined ? ` (pid ${rev.pid})` : ''}`,
                  }
                : rev.outcome === 'noop'
                  ? { outcome: 'applied' as const, detail: `resume ${rec.runnerId}` }
                  : {
                      outcome: 'refused' as const,
                      detail: `the valve opened but the session could not be revived: ${rev.detail ?? rev.reason}`,
                    },
            )
          }
          return settle(
            out.outcome === 'applied'
              ? { outcome: 'applied' as const, detail: `resume ${rec.runnerId}` }
              : { outcome: out.outcome, detail: out.reason },
          )
        },
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
          if (opts?.refresh === true && roster !== null) {
            const told = relayCredentialChange(roster)
            for (const short of told) requestSessionFacts(short, roster, { immediate: true })
            if (told.length > 0) logForDebugging(`[daemon] a credential moved in the screen: told ${told.length} runner(s) to read the account again — ${told.join(', ')}`)
          }
          return view
        },
        restartWhenIdle: by => restartWhenIdle(state, restartNeeds, by),
        processSweep: request => processSweep(state, { liveWorkers, requestShutdown: signal => requestShutdown(signal), bootStartInstant }, request),
      }, { socketPath: process.platform === 'win32' ? controlSockPath() : predecessorSockPath(process.pid) })
      await persistDaemonRecord(state.currentOwnerPid)
      armPlaneHeal(state, {
        controlKey,
        persistDaemonRecord,
        askLiveSessionsForFacts,
        armPeriodic,
      })
      armPeriodic('the armed-restart beat', () => armedRestartBeat(state, restartNeeds))
      armPeriodic('the sessionless beat', makeSessionlessBeat(state, { liveWorkers, requestShutdown: signal => requestShutdown(signal) }))
      armHandoverBeats(state, { handoverPredecessor, armPeriodic })
      const { startHostJobSweep } = await import('../services/host/jobs.js')
      state.stopHostJobs = startHostJobSweep()
      markDaemonReady(state)
      console.error('[daemon] control socket up — RPC: list/has/status/dispatch/reply/kill/shutdown')
      state.stopSaturnTicker = startSaturnTicker(
        {
          now: () => Date.now(),
          records: () => {
            const superseded = state.planeServedByOther !== null && isProcessAlive(state.planeServedByOther.pid)
            return Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined && (superseded ? (roster?.has(r.runnerId).alive ?? false) : !(handover?.holds(r.runnerId) ?? false)))
          },
          liveFacts: (account, sessionId) => {
            refreshSignInReads()
            return liveFactsForSessionFire(account, sessionId)
          },
          deriveAccount: modelKey => {
            refreshSignInReads()
            return deriveScheduleAccountForModel(modelKey)
          },
          deliver: async d => {
            const result = await concourseDispatchHandler({
              clientMessageId: d.clientMessageId,
              prompt: d.prompt,
              workspaceDir: d.workspaceId,
              by: d.by,
              priority: 'later',
              ...(d.origin !== undefined ? { origin: d.origin } : {}),
              ...(d.parked ? { resumeSessionId: d.sessionId } : { targetSessionId: d.sessionId }),
            })
            return { ok: result.ok, ...(result.error !== undefined ? { detail: result.error } : {}) }
          },
          birth: makeSaturnBirthPort({
            dispatch: async req => {
              const r = await concourseDispatchHandler(req)
              return {
                ok: r.ok,
                ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
                ...(r.error !== undefined ? { error: r.error } : {}),
                ...(r.heldReason !== undefined ? { heldReason: r.heldReason } : {}),
              }
            },
            withdraw: id => concourseDispatchHandler.withdraw(id),
            admit: makeConcourseAdmitHandler({
              roster: () => roster ?? undefined,
              ...warmAdmitDoors,
              onSpawned: (runnerId, _spec, pid) => {
                console.error(`[daemon] schedule-born session admitted: ${runnerId} (pid ${pid})`)
            noteHosted()
            if (roster !== null) onSeatSpawned(runnerId, roster)
              },
            }),
            contract: (sessionId, text, by) => applyConcourseContractOp(sessionId, { op: 'set', text }, by),
          }),
          screenOpen: () => (state.controlServer?.leaseCount() ?? 0) > 0,
          rosterChanged: sessionId => {
            if (roster !== null) pushScheduleRosterForSession(sessionId, roster)
          },
        },
        r => {
          console.error(`[daemon] saturn tick: ${r.fired} fired, ${r.replayed} replayed, ${r.held} held, ${r.missed} missed${r.dropped > 0 ? `, ${r.dropped} self-paced wake${r.dropped === 1 ? '' : 's'} dropped (stopped)` : ''}`)
        },
      )
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
  const door = process.platform === 'win32' ? 'control pipe' : 'control socket'
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
