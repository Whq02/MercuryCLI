
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, watch as watchDir, type FSWatcher } from 'node:fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { MERCURY_VERSION } from '../constants/product.js'
import { spawn } from 'node:child_process'
import { hasStoredOAuthToken } from '../utils/auth.js'
import { STORED_TOKEN_SCRUB_VARS } from '../utils/subprocessEnv.js'
import { describeArtifactIdentity } from '../utils/artifactIdentity.js'
import { MERCURY_DAEMON_PROTO } from './protocol.js'
import { DaemonBreaker } from '../utils/daemonBreaker.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { flagEnv, flagPair } from '../substrate/flagRegistry.js'
import { stampSpawnReceipt } from '../substrate/envStamps.js'
import { isCrewDaemon } from './daemonFeatureGates.js'
import { runTaskHeadless, buildHeadlessPrompt, getRunTimeoutMs, scrubSupervisorRoleEnv } from './headlessRun.js'
import { CREW_TEAM, makeCrewSpawnHandler } from './crewSpawn.js'
import {
  concourseWorkersPath,
  listConcourseWorkers,
  makeConcourseAdmitHandler,
  pauseConcourseWorker,
  readSessionWorkers,
  reconcileConcourseWorkers,
  resumeConcourseWorker,
  settleConcourseWorker,
} from './concourseSupervisor.js'
import {
  attachYieldConcourseSession,
  blurConcourseSession,
  completeRequestedPark,
  detachRespawnConcourseSession,
  focusConcourseSession,
  grantConcourseWorkflows,
  PARK_DRAIN_CUT_REASON,
  parkAllConcourseSessions,
  parkConcourseSession,
  pendingParkRequests,
  revokeConcourseWorkflows,
} from './concourseSupervisor.js'
import { answerPermissionAsk, onWorkerControlRequest } from './permissionAsks.js'
import {
  onSeatIdle,
  controlSessionAgent,
  onSeatLine,
  onSeatSpawned,
  publishSeatFacts,
  refreshSessionFacts,
  requestSessionFacts,
  rewindSession,
  seatTurnOpen,
  setSessionEffort,
  setSessionKitDial,
  setSessionModel,
  setSessionPermissionMode,
  setSessionSpawnSwitch,
  withdrawSessionSend,
} from './sessionSeat.js'
import { resetSeatProjections } from '../services/engine-connector/seatProjections.js'
import { armChildRssWatchdog } from './rssWatchdog.js'
import { sessionParkDrainMs, sweepIdleEmptyConcourseSessions } from './idleRetirement.js'
import {
  claimWarmRunner,
  ensureWarmRunner,
  onWarmRunnerLine,
  sweepIdleWarmRunners,
  warmRunnerCount,
  warmRunnerShorts,
} from './warmRunner.js'
import { stopConcourseSession, reviveConcourseWorker, setConcourseSessionTitle } from './concourseSupervisor.js'
import { applyConcourseContractOp } from './sessionContract.js'
import { applyConcourseScheduleOp } from './saturn.js'
import { deriveScheduleAccountForModel, readLiveAccountFacts, scheduleAccountVerdict } from './saturnAccount.js'
import { composeSignInView, refreshSignInReads } from './signInView.js'
import { fileMoveStamp, startSaturnTicker } from './saturnTicker.js'
import { makeSaturnBirthPort } from './saturnBirth.js'
import { makeConcourseDispatchHandler, readConcourseControlOps, recordConcourseControlOp, buildConcoursePromptFrame, failWorkingDispatchesForRunner, heldGitLaunchesFor, reconcileWorkingDispatches, replayGitBlockedDispatches, denyProceedLaunchesFor, replayDenyProceedDispatches } from './concourseDispatch.js'
import { TaskRoster } from './roster.js'
import {
  parseOwnerPid,
  parseOwnerFd,
  isProcessAlive,
  getProcessStartToken,
  getProcessStartTokenAsync,
  armOwnerPipe,
  startOwnerWatch,
  type OwnerPipeHandleV1,
  type OwnerWatchHandleV1,
} from './ownerWatch.js'
import { armDispatchDrain, type DispatchDrainHandle } from './dispatchDrain.js'
import { startControlServer, type ControlServerHandle } from './controlServer.js'
import { DAEMON_USAGE, parseDaemonVerb, supervisorRecordIdentity } from './verbs.js'
import {
  acquireSupervisorLock,
  clearControlKey,
  clearDeadSupervisorRecords,
  clearSupervisorState,
  controlKeyPath,
  controlSockPath,
  currentVersion,
  daemonControlRpc,
  daemonDir,
  mintControlKey,
  readSupervisorState,
  reassertControlKey,
  supervisorExitTeardownSync,
  supervisorStatePath,
  type SupervisorLock,
  writeSupervisorState,
} from './controlSocket.js'
import { recordSpawnExit } from '../utils/spawnLedger.js'
import { getMercuryDaemonStatus, formatMercuryDaemonStatus } from './status.js'
import { GLYPH } from '../components/mercury-ui/glyphs.js'

function resolveDir(args: string[]): string {
  const arg = args.find(a => !a.startsWith('-'))
  return arg ? resolve(arg) : process.cwd()
}


export async function daemonMain(args: string[]): Promise<void> {
  const verb = parseDaemonVerb(args)
  switch (verb.kind) {
    case 'status':
      return daemonStatusCmd()
    case 'stop':
      return daemonStopCmd(verb.args)
    case 'restart':
      return daemonRestartCmd()
    case 'help':
      // eslint-disable-next-line no-console
      console.log(DAEMON_USAGE)
      return
    case 'unknown':
      // eslint-disable-next-line no-console
      console.error(`mercury daemon: unknown verb '${verb.word}'\n${DAEMON_USAGE}`)
      process.exitCode = 1
      return
    case 'run':
      return daemonRun(verb.args)
  }
}

async function daemonStatusCmd(): Promise<void> {
  const snapshot = await getMercuryDaemonStatus()
  // eslint-disable-next-line no-console
  console.log(formatMercuryDaemonStatus(snapshot))
}

async function daemonStopCmd(args: string[]): Promise<void> {
  if (args.includes('--any') && args.includes('--keep')) {
    // eslint-disable-next-line no-console
    console.error('[daemon] stop: --any and --keep contradict — pick one (--any reaps in-flight workers, --keep leaves them running)')
    process.exitCode = 2
    return
  }
  const reapWorkers = args.includes('--any') || !args.includes('--keep')
  const reply = await daemonControlRpc({ op: 'shutdown', reapWorkers }, { timeoutMs: 3000 })
  if (reply.ok && reply.op === 'shutdown') {
    // eslint-disable-next-line no-console
    console.error(`[daemon] shutdown acknowledged — reaped ${reply.reaped} worker(s)`)
  } else if (!reply.ok && reply.code === 'ENOCONN') {
    const stale = await readSupervisorState()
    if (stale && !isProcessAlive(stale.pid)) {
      await clearDeadSupervisorRecords()
      // eslint-disable-next-line no-console
      console.error(`[daemon] no running supervisor to stop — swept the stale record of pid ${stale.pid} (control socket unreachable, process gone)`)
    } else if (stale) {
      const verdict = supervisorRecordIdentity(stale, getProcessStartToken(stale.pid))
      if (verdict === 'not-recorded-process') {
        await clearDeadSupervisorRecords()
        // eslint-disable-next-line no-console
        console.error(`[daemon] no running supervisor to stop — swept the stale record of pid ${stale.pid} (the pid was recycled: its live process is not the recorded supervisor)`)
      } else if (verdict === 'same-process') {
        // eslint-disable-next-line no-console
        console.error(`[daemon] control socket unreachable but pid ${stale.pid} is alive and IS the recorded supervisor — it may still be binding; retry in a moment, or end that process by hand`)
        process.exitCode = 1
      } else {
        // eslint-disable-next-line no-console
        console.error(`[daemon] control socket unreachable and pid ${stale.pid}'s identity could not be read — retry in a moment`)
        process.exitCode = 1
      }
    } else {
      const { probePidLock } = await import('../substrate/pidLock.js')
      const lockPath = join(daemonDir(), 'supervisor.lock')
      const lockHolder = existsSync(lockPath) ? await probePidLock(lockPath, { liveness: 'assume-alive' }) : null
      if (existsSync(lockPath) && lockHolder === null) {
        await clearDeadSupervisorRecords()
        // eslint-disable-next-line no-console
        console.error('[daemon] no running supervisor to stop — swept a lock-only leftover (supervisor.lock with no record, its holder gone or not the recorded process)')
      } else if (lockHolder !== null) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] no running supervisor to stop — but supervisor.lock is held by live pid ${lockHolder.pid} with no record beside it; if that pid is not a Mercury daemon, end it and re-run, or remove ${lockPath} by hand`)
        process.exitCode = 1
      } else {
        // eslint-disable-next-line no-console
        console.error('[daemon] no running supervisor to stop (control socket unreachable)')
      }
    }
  } else if (!reply.ok) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] stop failed: ${reply.code} ${reply.error}`)
  }
}

async function daemonRestartCmd(): Promise<void> {
  const { restartDaemon } = await import('./handshake.js')
  const receipt = await restartDaemon({ by: 'mercury daemon restart', posture: 'persistent' })
  // eslint-disable-next-line no-console
  console.error(`[daemon] ${receipt.line}`)
  if (receipt.state === 'refused') process.exitCode = 1
}

async function daemonRun(args: string[]): Promise<void> {
  const dir = resolveDir(args)
  const bootBuildTree = describeArtifactIdentity(currentVersion()).buildTree
  const foreground = process.stdout.isTTY === true || process.stderr.isTTY === true

  process.stderr.write(
    `[mercury-daemon] engaged v${MERCURY_VERSION} pid ${process.pid} dir ${dir} at ${new Date().toISOString()}\n`,
  )

  const scrubbed = scrubSupervisorRoleEnv()
  if (scrubbed.length > 0) {
    logForDebugging(`[daemon] scrubbed inherited role env (supervisor runs role-free): ${scrubbed.join(', ')}`)
  }
  if (isCrewDaemon()) {
    logForDebugging('[daemon] crew-host posture (MERCURY_DAEMON_CREW=1 — spawned by a /teammates engage)')
  }
  const lockIdentity = `daemon-${randomUUID()}`

  const breaker = new DaemonBreaker()

  {
    const { runBootRecovery } = await import('../substrate/recoveryOrchestrator.js')
    const rec = await runBootRecovery({ scope: 'daemon', projectDir: dir })
    const team = rec.teamJournal
    if (team && team.rolledForward.length + team.compensated.length > 0) {
      logForDebugging(
        `[daemon] team journal recovery: ${team.rolledForward.length} rolled forward, ${team.compensated.length} compensated`,
      )
    }
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
  // eslint-disable-next-line no-console
  console.error(
    `[daemon] starting supervisor for ${dir} ` +
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

  let controlServer: ControlServerHandle | null = null
  let stopPlaneHeal: (() => void) | null = null
  let restartArmed = false
  let restartAfterTeardown = false
  let stopArmedBeat: (() => void) | null = null
  let stopSaturnTicker: (() => void) | null = null
  let roster: TaskRoster | null = null
  const dispatchDrains: DispatchDrainHandle[] = []
  const idleNudges = new Map<string, () => void>()
  let ownerWatch: OwnerWatchHandleV1 | undefined
  let ownerPipe: OwnerPipeHandleV1 | undefined
  let ready = false
  let wakeReady: () => void = () => {}
  const readyPromise = new Promise<void>(resolve => {
    wakeReady = resolve
  })
  const startedAt = Date.now()
  let requestShutdown: (signal: string) => void = () => {}
  let supervisorLock: SupervisorLock | null = null
  let teardownComplete = false

  if (controlEnabled) {
    supervisorLock = await acquireSupervisorLock()
    const predecessorPid = flagEnv('MERCURY_DAEMON_SUCCESSOR_OF')
    if (!supervisorLock && predecessorPid) {
      const deadline = Date.now() + SUCCESSOR_LOCK_WAIT_MS
      while (!supervisorLock && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 100))
        supervisorLock = await acquireSupervisorLock()
      }
      if (supervisorLock) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] successor of pid ${predecessorPid} took the plane over (v${currentVersion()} proto ${MERCURY_DAEMON_PROTO})`)
      }
    }
    if (!supervisorLock) {
      // eslint-disable-next-line no-console
      console.error(
        `[daemon] another daemon already owns this config home (${daemonDir()}) — refusing to start so the live one is not clobbered`,
      )
      return
    }
    process.once('exit', code => {
      if (!teardownComplete) supervisorExitTeardownSync('exit-before-teardown', code)
    })
    try {
      roster = new TaskRoster({
        dir,
        breaker,
        maxInflight: MAX_INFLIGHT,
        onControlRequest: (short, frame) => {
          try {
            onWorkerControlRequest(short, frame, undefined, roster ?? undefined)
          } catch (e) {
            logForDebugging(`[daemon] onControlRequest(${short}) hook threw (ignored): ${e}`)
          }
        },
        onChildLine: (short, line) => {
          if (!short.startsWith('concourse-w') || roster === null) return
          onWarmRunnerLine(line)
          onSeatLine(short, line, roster)
        },
        onDegraded: (reason, short) => {
          // eslint-disable-next-line no-console
          console.error(`[daemon] ${GLYPH.warn} SUPERVISOR DEGRADED — ${reason}`)
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
          idleNudges.get(short)?.()
          if (short.startsWith('concourse-w') && roster !== null) {
            if (completeRequestedPark(short, roster)) {
              // eslint-disable-next-line no-console
              console.error(`[daemon] ${short} finished its turn and parked (a park was requested while it worked)`)
            }
            onSeatIdle(short, roster)
          }
        },
      })
      resetSeatProjections(dir)
      armChildRssWatchdog(roster)
      const controlKey = await mintControlKey()
      const warmDeps = {
        roster: () => roster ?? undefined,
        onWarmSpawned: (short: string, workspaceId: string, pid: number | undefined) => {
          // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
            console.error(
              `[daemon] concourse worker admitted: ${runnerId} (pid ${pid}) — ${spec.model}@${spec.effort}, cwd ${spec.cwd}`,
            )
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
          return out.outcome === 'applied' || out.outcome === 'noop'
            ? { ok: true }
            : { ok: false, error: out.detail ?? out.reason }
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
      controlServer = await startControlServer({
        roster,
        breaker,
        dir,
        startedAt,
        maxInflight: MAX_INFLIGHT,
        controlKey,
        isReady: () => ready,
        whenReady: () => readyPromise,
        nudgeAgent: agentName => idleNudges.get(agentName)?.(),
        crewSpawn: makeCrewSpawnHandler({
          roster: () => roster ?? undefined,
          dir,
          onSpawned: (name, spec, pid) => {
            const r = roster
            if (!r) return
            const handle = armDispatchDrain(r, {
              short: name,
              agentName: name,
              teamName: CREW_TEAM,
              hasSeen: id => r.hasSeenDispatch(name, id),
              markSeen: id => r.markSeenDispatch(name, id),
            })
            dispatchDrains.push(handle)
            idleNudges.set(name, () => handle.drain())
            // eslint-disable-next-line no-console
            console.error(`[daemon] crew teammate spawned: @${name} (pid ${pid}) — ${spec.model}@${spec.effort}, team crew, auto+recon posture`)
          },
        }),
        concourseAdmit: makeConcourseAdmitHandler({
          roster: () => roster ?? undefined,
          ...warmAdmitDoors,
          onSpawned: (runnerId, spec, pid) => {
            // eslint-disable-next-line no-console
            console.error(
              `[daemon] concourse worker admitted: ${runnerId} (pid ${pid}) — ${spec.model}@${spec.effort}, cwd ${spec.cwd}`,
            )
            if (roster !== null) onSeatSpawned(runnerId, roster)
          },
        }),
        concourseDispatch: concourseDispatchHandler,
        concourseWithdraw: clientMessageId => concourseDispatchHandler.withdraw(clientMessageId),
        concourseWarm: req => ensureWarmRunner(req, warmDeps),
        warmRunnerCount: () => warmRunnerCount(),
        concourseList: () => {
          if (!roster) return []
          const entries = roster.list().filter(j => !j.outcome)
          const live = new Set(entries.map(j => j.short))
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
        sessionRewind: async req => {
          if (roster === null) {
            return { outcome: 'refused' as const, mode: req.mode, refusal: 'no-channel' as const, detail: 'daemon roster not ready' }
          }
          return rewindSession(req.sessionId, { mode: req.mode, userMessageId: req.userMessageId, ...(req.dryRun === true ? { dryRun: true } : {}) }, roster)
        },
        concourseControl: async ({ action, sessionId, by, reason, hard, requestId, allow, answer, model, effort, mode, contract, kitEdit, scheduleEdit, spawnSwitch, clientOpId, mintedAtMs, title, titleSource, agentId, note, clientMessageId }) => {
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
              roster ?? undefined,
              by,
              {
                onGitReady: folder => {
                  const waiting = heldGitLaunchesFor(folder)
                  void replayGitBlockedDispatches(folder, concourseDispatchHandler)
                    .then(rows => {
                      for (const row of rows) {
                        // eslint-disable-next-line no-console
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
                          // eslint-disable-next-line no-console
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
              answer as Parameters<typeof answerPermissionAsk>[5],
            )
          }
          if (action === 'park-all') {
            const all = parkAllConcourseSessions(by, roster ?? undefined, undefined, {
              reason: undefined,
              exceptFocusedByLiveTerminal: true,
            })
            // eslint-disable-next-line no-console
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
            refreshSignInReads()
            return settle(
              applyConcourseScheduleOp(sessionId, scheduleEdit, by, {
                deriveAccount: deriveScheduleAccountForModel,
                preflight: (account, nextFireMs) =>
                  scheduleAccountVerdict({
                    account,
                    nextFireMs,
                    nowMs: Date.now(),
                    live: readLiveAccountFacts(account),
                  }),
              }),
            )
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
            return roster !== null ? await setSessionModel(sessionId, model, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-effort') {
            if (effort === undefined || effort === '') return { outcome: 'refused' as const, detail: 'set-effort requires effort' }
            return roster !== null ? setSessionEffort(sessionId, effort, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-spawn-switch') {
            if (spawnSwitch === undefined) return { outcome: 'refused' as const, detail: 'set-spawn-switch requires { spawnSwitch: { kind: subagents|workflows, on } }' }
            return roster !== null ? setSessionSpawnSwitch(sessionId, spawnSwitch, by, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-permission-mode') {
            if (mode === undefined || mode === '') return { outcome: 'refused' as const, detail: 'set-permission-mode requires mode' }
            return roster !== null ? setSessionPermissionMode(sessionId, mode, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'session-facts') {
            return roster !== null ? refreshSessionFacts(sessionId, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'focus' || action === 'blur') {
            const out = action === 'focus' ? focusConcourseSession(sessionId, by) : blurConcourseSession(sessionId, by)
            if (out.outcome === 'applied') {
              const left = action === 'focus' && out.cleared.length > 0 ? ` — seat left ${out.cleared.join(', ')}` : ''
              return { outcome: 'applied' as const, detail: `${action} ${out.runnerId}${left}` }
            }
            return out.outcome === 'noop'
              ? { outcome: 'noop' as const, detail: out.reason }
              : { outcome: 'refused' as const, detail: out.reason }
          }
          if (action === 'interrupt') {
            const delivered =
              roster != null &&
              roster.control(
                rec.runnerId,
                JSON.stringify({
                  type: 'control_request',
                  request_id: `concourse-interrupt-${clientOpId ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`}`,
                  request: { subtype: 'interrupt', ...(hard === true ? { hard: true } : {}) },
                }),
              )
            if (delivered && hard === true && roster !== null) {
              const live = roster
              const runnerId = rec.runnerId
              setTimeout(() => {
                const row = live.list().find(j => j.short === runnerId)
                if (!seatTurnOpen(row)) return
                // eslint-disable-next-line no-console
                console.error(`[daemon] hard stop: ${runnerId} still holds its turn a second after the interrupt — cutting the runner`)
                live.kill(runnerId)
                const t0 = Date.now()
                const publishWhenGone = (): void => {
                  const after = live.list().find(j => j.short === runnerId)
                  if (after !== undefined && !after.outcome && Date.now() - t0 < 5_000) {
                    setTimeout(publishWhenGone, 100).unref()
                    return
                  }
                  publishSeatFacts(runnerId, undefined, live)
                }
                publishWhenGone()
              }, 1_000).unref()
            }
            return settle(
              delivered
                ? { outcome: 'applied' as const, detail: `${hard === true ? 'hard stop' : 'interrupt'} ${rec.runnerId}` }
                : { outcome: 'refused' as const, detail: 'worker has no live control channel' },
            )
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
          if (action === 'stop') {
            if (roster !== null) {
              roster.control(
                rec.runnerId,
                JSON.stringify({
                  type: 'control_request',
                  request_id: `concourse-interrupt-stop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
                  request: { subtype: 'interrupt', hard: true },
                }),
              )
            }
            const out = stopConcourseSession(sessionId, by, roster ?? undefined)
            return out.outcome === 'refused'
              ? { outcome: 'refused' as const, detail: out.reason }
              : out.outcome === 'noop'
                ? { outcome: 'noop' as const, detail: out.reason }
                : out.acknowledged
                  ? { outcome: 'applied' as const, detail: `stopped ${out.runnerId}` }
                  : { outcome: 'applied' as const, detail: `stop sent — ${out.runnerId} ends its turn and its agents; the row reads stopped once it is gone` }
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
              void Promise.resolve(
                roster.reply(
                  rec.runnerId,
                  buildConcoursePromptFrame(
                    '[switchboard notice] The workflows-allowed tag just landed on this session — delegation tools (subagents and workflows) are available from your next turn. Automated notice; no reply needed.',
                  ),
                ),
              ).catch(() => {})
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
        onShutdown: reapWorkers => {
          const workers: ReturnType<NonNullable<typeof roster>['liveWorkerFacts']> = []
          if (reapWorkers && roster) {
            for (const w of roster.liveWorkerFacts()) {
              if (roster.kill(w.short)) workers.push(w)
            }
          }
          setImmediate(() => requestShutdown('control:shutdown'))
          return { reaped: workers.length, workers }
        },
        hello: () => ({
          version: currentVersion(),
          buildTree: bootBuildTree,
          pid: process.pid,
          startedAt,
          ownerPid: parseOwnerPid(),
          foreground,
          ...liveWorkers(),
          warm: warmRunnerCount(),
          restartArmed,
        }),
        signIns: opts => composeSignInView(opts),
        restartWhenIdle: by => {
          const { live } = liveWorkers()
          if (foreground) {
            return { state: 'refused' as const, live, detail: 'runs on a terminal: stop it there (ctrl-c) and run `mercury daemon` again' }
          }
          if (flagEnv('MERCURY_DAEMON_SUCCESSOR_OF') && Date.now() - startedAt < RESTART_STORM_GUARD_MS) {
            return {
              state: 'refused' as const,
              live,
              detail: `came back unchanged ${Math.round((Date.now() - startedAt) / 1000)}s ago (still v${currentVersion()}, protocol ${MERCURY_DAEMON_PROTO}): the bundle at ${process.argv[1] ?? '?'} is what a restart runs — deploy the new build first`,
            }
          }
          if (live > 0) {
            restartArmed = true
            // eslint-disable-next-line no-console
            console.error(`[daemon] restart armed by ${by} — re-executes as the deployed build when the ${live} live worker(s) finish`)
            return { state: 'armed' as const, live }
          }
          // eslint-disable-next-line no-console
          console.error(`[daemon] restart requested by ${by} — idle, re-executing as the deployed build`)
          restartAfterTeardown = true
          setImmediate(() => requestShutdown('control:restart-when-idle'))
          return { state: 'restarting' as const, live: 0 }
        },
      })
      const bootStartToken = await getProcessStartTokenAsync(process.pid)
      await writeSupervisorState({
        pid: process.pid,
        version: currentVersion(),
        origin: 'transient',
        startedAt,
        dir,
        controlSock: controlSockPath(),
        proto: MERCURY_DAEMON_PROTO,
        buildTree: bootBuildTree,
        ownerPid: parseOwnerPid(),
        foreground,
        startToken: bootStartToken,
      })
      {
        let healInflight = false
        let healQueued = false
        const healCheck = async (): Promise<void> => {
          if (healInflight) {
            healQueued = true
            return
          }
          healInflight = true
          try {
            const sockMissing = process.platform === 'win32' ? false : !existsSync(controlSockPath())
            const keyMissing = !existsSync(controlKeyPath())
            let foreignOwner = false
            let stateMissing = false
            try {
              const raw = JSON.parse(readFileSync(supervisorStatePath(), 'utf8')) as { pid?: number }
              if (typeof raw?.pid === 'number' && raw.pid !== process.pid) {
                foreignOwner = isProcessAlive(raw.pid)
                stateMissing = !foreignOwner
              }
            } catch {
              stateMissing = true
            }
            if (foreignOwner) return
            if (!sockMissing && !keyMissing && !stateMissing) return
            logForDebugging(
              `[daemon] control plane degraded (sock:${sockMissing} key:${keyMissing} state:${stateMissing}) — re-asserting`,
            )
            await reassertControlKey(controlKey)
            await writeSupervisorState({
              pid: process.pid,
              version: currentVersion(),
              origin: 'transient',
              startedAt,
              dir,
              controlSock: controlSockPath(),
              proto: MERCURY_DAEMON_PROTO,
              buildTree: bootBuildTree,
              ownerPid: parseOwnerPid(),
              foreground,
              startToken: bootStartToken,
            })
            if (sockMissing) await controlServer?.rebind()
          } catch (e) {
            logForDebugging(`[daemon] plane self-heal failed (the next signal or floor retries): ${e}`)
          } finally {
            healInflight = false
            if (healQueued) {
              healQueued = false
              void healCheck()
            }
          }
        }
        const planeHeal = setInterval(() => {
          void healCheck()
        }, PLANE_HEAL_FLOOR_MS)
        planeHeal.unref?.()
        const planeNames = new Set([
          basename(controlKeyPath()),
          basename(supervisorStatePath()),
          ...(process.platform === 'win32' ? [] : [basename(controlSockPath())]),
        ])
        const planeDirs = new Set([dirname(controlKeyPath()), ...(process.platform === 'win32' ? [] : [dirname(controlSockPath())])])
        let healSignal: ReturnType<typeof setTimeout> | undefined
        const planeWatchers: FSWatcher[] = []
        for (const planeDir of planeDirs) {
          try {
            const watcher = watchDir(planeDir, { persistent: false }, (_event, name) => {
              if (name !== null && name !== undefined && !planeNames.has(String(name))) return
              if (healSignal !== undefined) return
              healSignal = setTimeout(() => {
                healSignal = undefined
                void healCheck()
              }, PLANE_HEAL_COALESCE_MS)
              healSignal.unref?.()
            })
            watcher.on('error', e => logForDebugging(`[daemon] plane watch on ${planeDir} failed (the floor keeps the heal): ${e}`))
            planeWatchers.push(watcher)
          } catch (e) {
            logForDebugging(`[daemon] plane watch on ${planeDir} did not arm (the floor keeps the heal): ${e}`)
          }
        }
        stopPlaneHeal = () => {
          clearInterval(planeHeal)
          if (healSignal !== undefined) clearTimeout(healSignal)
          for (const watcher of planeWatchers) watcher.close()
        }
      }
      {
        const armedBeat = setInterval(() => {
          if (!restartArmed || restartAfterTeardown) return
          if (liveWorkers().live > 0) return
          restartArmed = false
          restartAfterTeardown = true
          // eslint-disable-next-line no-console
          console.error('[daemon] armed restart — idle now, re-executing as the deployed build')
          requestShutdown('restart-when-idle:armed')
        }, ARMED_RESTART_BEAT_MS)
        armedBeat.unref?.()
        stopArmedBeat = () => clearInterval(armedBeat)
      }
      ready = true
      wakeReady()
      // eslint-disable-next-line no-console
      console.error('[daemon] control socket up — RPC: list/has/status/dispatch/reply/kill/shutdown')
      stopSaturnTicker = startSaturnTicker(
        {
          now: () => Date.now(),
          records: () => Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined),
          liveFacts: account => {
            refreshSignInReads()
            return readLiveAccountFacts(account)
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
                // eslint-disable-next-line no-console
                console.error(`[daemon] schedule-born session admitted: ${runnerId} (pid ${pid})`)
                if (roster !== null) onSeatSpawned(runnerId, roster)
              },
            }),
            contract: (sessionId, text, by) => applyConcourseContractOp(sessionId, { op: 'set', text }, by),
          }),
          screenOpen: () => (controlServer?.leaseCount() ?? 0) > 0,
        },
        r => {
          // eslint-disable-next-line no-console
          console.error(`[daemon] saturn tick: ${r.fired} fired, ${r.replayed} replayed, ${r.held} held, ${r.missed} missed`)
        },
      )
      if (parseOwnerPid() !== null && flagEnv('MERCURY_DAEMON_NO_SELF_WARM') !== '1') {
        void ensureWarmRunner({ workspaceDir: dir }, warmDeps)
          .then(w => {
            if (w.state === 'refused') {
              // eslint-disable-next-line no-console
              console.error(`[daemon] boot self-warm refused — ${w.detail ?? 'unspecified'} (the first dispatch spawns cold)`)
            }
          })
          .catch(e => logForDebugging(`[daemon] boot self-warm failed (the first dispatch spawns cold): ${e}`))
      }
      {
        const liveShorts = new Set(
          roster ? roster.list().filter(j => !j.outcome).map(j => j.short) : [],
        )
        const bootReconcile = reconcileConcourseWorkers(liveShorts)
        let reconcileRosterSig = [...liveShorts].sort().join(' ')
        let reconcileRecordsStamp = fileMoveStamp(concourseWorkersPath())
        let reconcileHadLive = bootReconcile.live.length > 0
        const reconcileTick = setInterval(() => {
          try {
            const live = new Set(
              roster ? roster.list().filter(j => !j.outcome).map(j => j.short) : [],
            )
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
          } catch {
          }
          try {
            sweepIdleWarmRunners(warmDeps)
          } catch (e) {
            logForDebugging(`[daemon] warm runner sweep threw (ignored): ${e}`)
          }
        }, RECONCILE_TICK_MS)
        reconcileTick.unref?.()
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[daemon] ${GLYPH.warn} control layer FAILED to start — continuing as pure cron daemon (no roster): ${e}`,
      )
      logForDebugging(`[daemon] control layer failed to start (continuing as pure cron daemon): ${e}`)
      controlServer = null
      roster = null
    }
  }

  return new Promise<void>(resolveShutdown => {
    const keepAlive = setInterval(() => {}, 1 << 30)
    let shuttingDown = false
    const shutdown = (signal: string) => {
      if (shuttingDown) return
      shuttingDown = true
      stopPlaneHeal?.()
      stopArmedBeat?.()
      stopSaturnTicker?.()
      logForDebugging(`[daemon] received ${signal}, shutting down`)
      // eslint-disable-next-line no-console
      console.error(`[daemon] ${signal} — shutting down`)
      for (const d of dispatchDrains.splice(0)) {
        try {
          d.dispose()
        } catch (e) {
          logForDebugging(`[daemon] drain dispose failed (ignored): ${e}`)
        }
      }
      idleNudges.clear()
      ownerWatch?.stop()
      ownerWatch = undefined
      ownerPipe?.close()
      ownerPipe = undefined
      if (roster) {
        for (const j of roster.list()) {
          if (!j.outcome) {
            recordSpawnExit({
              kind: j.via === 'stream-json' ? 'long-lived' : 'headless',
              event: 'reap',
              id: j.short,
              pid: j.pid,
              reason: `daemon-shutdown:${signal}`,
            })
            roster.kill(j.short)
          }
        }
      }
      void (async () => {
        try {
          await controlServer?.close()
        } catch (e) {
          logForDebugging(`[daemon] error closing control server: ${e}`)
        }
        if (controlEnabled) await clearControlKey().catch(() => {})
        if (controlEnabled) await clearSupervisorState().catch(() => {})
        recordSpawnExit({
          kind: 'supervisor',
          event: 'exit',
          id: 'supervisor',
          pid: process.pid,
          reason: `shutdown:${signal}`,
        })
        teardownComplete = true
        if (restartAfterTeardown) spawnSuccessorDaemon()
        await supervisorLock?.release().catch(() => {})
        supervisorLock = null
        clearInterval(keepAlive)
        resolveShutdown()
        setTimeout(() => process.exit(0), 250)
      })()
      const bail = setTimeout(() => process.exit(1), 15_000)
      bail.unref?.()
    }
    let orphanParking = false
    const parkAllThenShutdown = async (signal: string): Promise<void> => {
      if (orphanParking || shuttingDown) return
      orphanParking = true
      try {
        const receipt = parkAllConcourseSessions(`daemon:${signal}`, roster ?? undefined)
        // eslint-disable-next-line no-console
        console.error(
          `[daemon] the screen is gone — parking every active session: parked ${receipt.parked.length}, draining ${receipt.draining.length} (finishing their turns), released ${receipt.released.length} newborn(s), skipped ${receipt.skipped.length}${receipt.refused.length > 0 ? `, refused ${receipt.refused.join(', ')}` : ''}`,
        )
        const ceilingMs = sessionParkDrainMs()
        const startedDrain = Date.now()
        while (pendingParkRequests().length > 0 && Date.now() - startedDrain < ceilingMs) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        for (const short of pendingParkRequests()) {
          const rec = readSessionWorkers()[short]
          if (rec === undefined) continue
          const cut = parkConcourseSession(rec.sessionId, `daemon:${signal}`, roster ?? undefined, undefined, { afterTurn: false, reason: PARK_DRAIN_CUT_REASON })
          // eslint-disable-next-line no-console
          console.error(`[daemon] ${short} was still mid-turn at the drain ceiling — ${cut.outcome === 'applied' ? 'its turn is cut and it parks' : cut.outcome}`)
        }
      } catch (e) {
        logForDebugging(`[daemon] park-all at the orphan reap threw (ignored — shutting down): ${e}`)
      }
      shutdown(signal)
    }
    requestShutdown = shutdown
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGHUP', () => shutdown('SIGHUP'))
    process.on('SIGBREAK', () => shutdown('SIGBREAK'))

    const crashShutdown = (label: string, err: unknown): void => {
      // eslint-disable-next-line no-console
      console.error(`[daemon] ${label} — reaping workers + control socket, then exiting:`, err)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('../utils/crashReport.js') as typeof import('../utils/crashReport.js')
        crashMod.persistCrashReport(err, undefined, label === 'uncaughtException' ? 'uncaught-exception' : 'unhandled-rejection')
      } catch {
      }
      try {
        shutdown(label)
      } catch (e) {
        logForDebugging(`[daemon] crash shutdown threw: ${e}`)
      }
      const bail = setTimeout(() => process.exit(1), 2000)
      bail.unref?.()
    }
    process.on('uncaughtException', err => crashShutdown('uncaughtException', err))
    process.on('unhandledRejection', reason => crashShutdown('unhandledRejection', reason))

    const ownerPid = parseOwnerPid()
    const persist = isEnvTruthy(flagEnv('MERCURY_DAEMON_PERSIST'))
    if (ownerPid !== null && !persist) {
      const ownerStartToken = getProcessStartToken(ownerPid)
      ownerWatch = startOwnerWatch({
        ownerPid,
        baselineToken: ownerStartToken,
        // eslint-disable-next-line no-console
        log: line => console.error(line),
        onOrphan: why => {
          ownerPipe?.close()
          // eslint-disable-next-line no-console
          console.error(`[daemon] owner pid ${ownerPid} gone (${why}) — parking every active session, then self-reaping (orphaned auto-start)`)
          void parkAllThenShutdown('owner-orphaned')
        },
      })
      const ownerFd = parseOwnerFd()
      if (ownerFd !== null) {
        // eslint-disable-next-line no-console
        ownerPipe = armOwnerPipe(ownerFd, () => ownerWatch?.ownerPipeClosed(), line => console.error(line))
        if (!ownerPipe.armed) {
          // eslint-disable-next-line no-console
          console.error(`[daemon] owner pipe not armed (${ownerPipe.why ?? 'unknown'}) — the liveness beat and the minute identity probe watch alone`)
        }
      }
    }
  })
}

const SUCCESSOR_LOCK_WAIT_MS = 10_000
const RESTART_STORM_GUARD_MS = 60_000
const ARMED_RESTART_BEAT_MS = 4_000
const PLANE_HEAL_FLOOR_MS = 30_000
const PLANE_HEAL_COALESCE_MS = 250
const RECONCILE_TICK_MS = 60_000

function spawnSuccessorDaemon(): number | undefined {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ...flagPair('MERCURY_DAEMON_SUCCESSOR_OF', String(process.pid)) }
    stampSpawnReceipt(env, ['MERCURY_DAEMON_SUCCESSOR_OF'])
    if (hasStoredOAuthToken()) {
      const stripped: string[] = []
      for (const k of STORED_TOKEN_SCRUB_VARS) {
        if (env[k] !== undefined) stripped.push(k)
        delete env[k]
      }
      if (stripped.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] successor scrub — a stored sign-in exists; the successor re-resolves it (dropped: ${stripped.join(', ')})`)
      }
    }
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', e => logForDebugging(`[daemon] successor spawn error (ignored): ${e}`))
    child.unref()
    // eslint-disable-next-line no-console
    console.error(`[daemon] successor spawned — pid ${child.pid} runs ${process.argv[1] ?? '?'} as deployed`)
    return child.pid
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] successor spawn failed — the next screen starts a daemon: ${e}`)
    return undefined
  }
}
