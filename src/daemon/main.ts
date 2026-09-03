// The Mercury daemon — the always-alive SUPERVISOR: the control-socket RPC
// server, the session-worker roster, the warm pool, and SATURN's fire
// engine (saturnTicker.ts — session schedules fired from the records).
//
// SAFETY (read before touching): this is the ONLY place in the tree that can
// autonomously SPAWN agent runs. It is opt-in by construction —
//   • It runs ONLY when the user explicitly invokes `mercury daemon` (cli.tsx
//     fast-path). Nothing imports or auto-starts daemonMain anywhere else.
//   • SATURN's kill switch (MERCURY_SATURN_DISABLE) ends every fire tick
//     before any effect; the ticker's own guard ladder (the fire-time
//     account preflight, the catch-up window, the held-fire bank) is in
//     saturnTicker.ts.
//   • The roster's dispatch path shares ONE circuit breaker + in-flight cap
//     (daemonBreaker.ts) so runaway failure pauses the fleet.
//   • It does NOT change the base behavior: the cli.tsx route stays gated on
//     feature('DAEMON') for bare-stamp builds; only Mercury (always)
//     additionally enables it.
//
// Execution model: dispatched runs execute HEADLESSLY in isolated children
// (`node <this mercury.mjs> -p "<prompt>"`, headlessRun.ts) or as roster
// session workers; a crashing or hanging run cannot take the daemon down.

import { randomUUID } from 'crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'
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
import { isCrewDaemon } from './daemonFeatureGates.js'
import { runTaskHeadless, buildHeadlessPrompt, getRunTimeoutMs, scrubSupervisorRoleEnv } from './headlessRun.js'
import { CREW_TEAM, makeCrewSpawnHandler } from './crewSpawn.js'
import {
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
import { startSaturnTicker } from './saturnTicker.js'
import { makeSaturnBirthPort } from './saturnBirth.js'
import { makeConcourseDispatchHandler, readConcourseControlOps, recordConcourseControlOp, buildConcoursePromptFrame, failWorkingDispatchesForRunner, heldGitLaunchesFor, reconcileWorkingDispatches, replayGitBlockedDispatches, denyProceedLaunchesFor, replayDenyProceedDispatches } from './concourseDispatch.js'
import { TaskRoster } from './roster.js'
import {
  parseOwnerPid,
  isProcessAlive,
  decideOrphanShutdown,
  getProcessStartToken,
  getProcessStartTokenAsync,
  ownerIdentityMatches,
  OWNER_WATCH_INTERVAL_MS,
  OWNER_WATCH_GRACE_CHECKS,
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

/**
 * Resolve the project directory the daemon schedules for. Optional first
 * positional arg overrides; otherwise the current working directory. The daemon
 * has no bootstrap state, so this is passed explicitly to the scheduler/cron
 * helpers (the `dir` param keeps them off getProjectRoot()).
 */
function resolveDir(args: string[]): string {
  const arg = args.find(a => !a.startsWith('-'))
  return arg ? resolve(arg) : process.cwd()
}

//
// ITEM 6.3 — Honesty-gated session→session handoff summary + ARTIFACTS capture.
// Both are daemon-only and now WIRED LIVE for Mercury (default-on inside the
// daemon, per-feature `=0` opt-out) — the gates live in ./daemonFeatureGates so
// the /substrate + /deck UI snapshot reads the SAME source of truth without
// importing the daemon's server internals. The daemon itself stays an explicit
// `mercury daemon` opt-in.
//   - handoff summary: writes a handoff sidecar per recurring task on each
//     completion and folds the PRIOR summary into the NEXT fire's prompt so
//     re-fired sessions carry honest continuity (unbacked claims demoted).
//   - artifacts: stores every child's captured stdout under the project scope
//     slug so a LATER session/agent can LIST + RETRIEVE it (ArtifactsList tool).
// (The old fire riders' opt-outs died with their engine.)
// short-circuit, no sidecar / no store touched, daemon behaves as before.
//

/**
 * Daemon entrypoint. Invoked ONLY from cli.tsx's `daemon` fast-path on explicit
 * `mercury daemon`. Routes a subcommand (run / status / stop / restart),
 * defaulting to `run` (the long-running supervisor) for back-compat with bare
 * `mercury daemon`.
 */
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
      // A word the grammar does not know is refused here. It used to fall
      // through to the supervisor as its scheduling directory, so `--help`
      // started the scheduler in the operator's console.
      // eslint-disable-next-line no-console
      console.error(`mercury daemon: unknown verb '${verb.word}'\n${DAEMON_USAGE}`)
      process.exitCode = 1
      return
    case 'run':
      return daemonRun(verb.args)
  }
}

/**
 * `mercury daemon status` — probe the running supervisor over the control socket
 * and print a flat status block. Exits without starting anything.
 */
async function daemonStatusCmd(): Promise<void> {
  const snapshot = await getMercuryDaemonStatus()
  // eslint-disable-next-line no-console
  console.log(formatMercuryDaemonStatus(snapshot))
}

/**
 * `mercury daemon stop [--any]` — ask the running supervisor to shut down over
 * the control socket. `--any` reaps in-flight workers too (default). Prints the
 * result; exits.
 */
async function daemonStopCmd(args: string[]): Promise<void> {
  // Contradictory flags refuse loudly — --any silently overrode a typed
  // --keep (or a misspelled one), reaping the workers the operator asked
  // to keep.
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
    // Nothing answers. A record left by a supervisor that died hard (the
    // ordinary win32 death — TerminateProcess raises no exit event) used to
    // stay in place, so `daemon status` kept calling it "running" and the
    // sweep this very command is named as the remedy for never happened
    // (TASK-014 w5-f01-01). Sweep only a record whose pid is GONE: a live
    // pid that is not answering may still be binding its socket, and
    // sweeping under it would orphan a serving daemon.
    const stale = await readSupervisorState()
    if (stale && !isProcessAlive(stale.pid)) {
      await clearDeadSupervisorRecords()
      // eslint-disable-next-line no-console
      console.error(`[daemon] no running supervisor to stop — swept the stale record of pid ${stale.pid} (control socket unreachable, process gone)`)
    } else if (stale) {
      // The pid is alive — but a pid is not an identity: Windows recycles
      // them fast, and a by-hand kill against a recycled pid aims the
      // operator at an innocent process (the warning above
      // clearDeadSupervisorRecords). The ONE identity
      // owner answers WHICH process holds the pid: byte-equal against the
      // record's own startToken where one exists, the birth-time fallback
      // for a pre-token record (the union of the two D-vocabulary arms).
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
      // THE LOCK-ONLY LEFTOVER (TASK-017 S2, win32-supervisor-lock-no-reuse-
      // token): a supervisor.lock with NO supervisor.json beside it — the
      // documented 15s bail exit produces exactly this (the json goes at
      // teardown before the lock), as does a partial win32 sweep under a
      // scanner's handle — refused every `daemon run` and every auto-start
      // ("another daemon already owns this config home") while THIS verb,
      // the remedy `daemon status` prints, swept nothing because it only
      // read the json. ENOCONN above is the control-socket dead-confirm the
      // clearDeadSupervisorRecords contract demands; the identity-aware lock
      // probe (the reuse guard now armed on every platform) decides the rest.
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

/**
 * `mercury daemon restart` — the version handshake's heal by hand. A daemon
 * that speaks the handshake re-executes itself as the deployed build (now
 * when idle, armed otherwise); a pre-handshake daemon is stopped when idle
 * and a PERSISTENT successor started — this process exits at once, so an
 * owned successor would self-reap behind it. Prints the typed receipt; a
 * refusal exits non-zero.
 */
async function daemonRestartCmd(): Promise<void> {
  const { restartDaemon } = await import('./handshake.js')
  const receipt = await restartDaemon({ by: 'mercury daemon restart', posture: 'persistent' })
  // eslint-disable-next-line no-console
  console.error(`[daemon] ${receipt.line}`)
  if (receipt.state === 'refused') process.exitCode = 1
}

/**
 * `mercury daemon run` — the long-running SUPERVISOR. Builds (when the
 * control layer is enabled) the control-socket RPC server + worker roster +
 * supervisor-state record + control key + SATURN's fire ticker, starts
 * everything, and keeps the process alive until SIGINT/SIGTERM, at which
 * point it tears everything down cleanly. Returns a promise that resolves
 * on shutdown.
 *
 * The control layer is stamp-gated and opt-out via MERCURY_DAEMON_CONTROL=0.
 */
async function daemonRun(args: string[]): Promise<void> {
  const dir = resolveDir(args)
  // THE VERSION FACT, read once at boot: a redeploy swaps the manifest
  // beside this still-running process (runtime/dist is renamed away and the
  // new build moved in), so a later read would describe the successor's
  // bytes, not ours. The handshake publishes exactly this capture.
  const bootBuildTree = describeArtifactIdentity(currentVersion()).buildTree
  // A daemon on a terminal never re-executes itself: a detached successor
  // writing to a closed tty is a crash class, and its terminal is where the
  // operator restarts it.
  const foreground = process.stdout.isTTY === true || process.stderr.isTTY === true

  // The unconditional engage stamp — the Mercury fingerprint the
  // foreign-harness inversion reads (utils/knownAgentClis.ts): a daemon.log
  // with no such grammar anywhere was written by another tool's daemon.
  // stderr, never gated: the detached spawn wires both stdio fds to
  // daemon.log (ownedDaemon.ts), and a foreground run gets one honest line.
  process.stderr.write(
    `[mercury-daemon] engaged v${MERCURY_VERSION} pid ${process.pid} dir ${dir} at ${new Date().toISOString()}\n`,
  )

  // The supervisor must run ROLE-FREE. A role-tagged process that auto-started
  // this detached daemon would leak its role into our inherited env; the cron
  // one-shot path (runTaskHeadless) spawns `-p` children with `env: process.env`
  // verbatim, so an unrelated scheduled task would otherwise adopt that
  // persona. Scrub once, before any spawn. (buildStreamJsonInvocation re-stamps
  // the intended role on its own clone, so the long-lived workers are
  // unaffected.)
  const scrubbed = scrubSupervisorRoleEnv()
  if (scrubbed.length > 0) {
    logForDebugging(`[daemon] scrubbed inherited role env (supervisor runs role-free): ${scrubbed.join(', ')}`)
  }
  // Boot posture provenance (daemon.log forensics): name WHICH engage spawned
  // this daemon so a dead-worker investigation can tell a /teammates host
  // from a scheduler daemon.
  if (isCrewDaemon()) {
    logForDebugging('[daemon] crew-host posture (MERCURY_DAEMON_CREW=1 — spawned by a /teammates engage)')
  }
  // Stable owner key for this daemon instance's own identity lines. The
  // daemon has no session id, so we mint a per-process UUID; PID remains
  // the liveness probe.
  const lockIdentity = `daemon-${randomUUID()}`

  // ITEM 6.4 — global circuit-breaker. Always on for the (opt-in) daemon; it can
  // only SUPPRESS runs, never add them. Records every child outcome; once too
  // much failure accumulates it trips OPEN and pauses dispatching for a cooldown,
  // then half-opens to probe. Defaults conservative (5 consecutive failures or a
  // saturated failing window) so a healthy daemon never notices it. Shared
  // with the roster's dispatch path.
  const breaker = new DaemonBreaker()

  // Boot reconciliation FIRST: ONE orchestrated
  // pass — orphan durable-publish temps, the teams operation journal, and
  // the change-set journal — BEFORE anything reads the stores. Never
  // throws; failures ride the report.
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
  // A 'working' dispatch whose worker already ended belongs to a daemon
  // that died mid-degrade — settle it before any surface reads the ledger
  // (TASK-014 w5-f08-02: a fresh daemon over the same dir re-served the
  // stale 'working' row byte-identical).
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

  // Cap overlapping headless child runs so dispatch bursts can't spawn
  // unbounded token-spending agents. Override with MERCURY_DAEMON_MAX_INFLIGHT.
  // Shared with the roster's dispatch path.
  const MAX_INFLIGHT = (() => {
    const n = parseInt(flagEnv('MERCURY_DAEMON_MAX_INFLIGHT') ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : 4
  })()

  //
  // SUPERVISOR control layer — the control-socket RPC server + worker roster.
  // Flag-gated and opt-out via MERCURY_DAEMON_CONTROL=0. It
  // serves `list/has/status/dispatch/reply/kill/shutdown` over a loopback unix
  // socket and tracks dispatched runs in a roster that shares THIS breaker +
  // in-flight cap.
  //
  const controlEnabled =
    !isEnvTruthy(flagEnv('MERCURY_DAEMON_CONTROL_DISABLED')) &&
    flagEnv('MERCURY_DAEMON_CONTROL') !== '0'

  let controlServer: ControlServerHandle | null = null
  // (close audit): the plane self-heal must die FIRST at shutdown —
  // a heal tick racing the teardown re-wrote supervisor state and re-bound
  // the socket for a dying pid.
  let stopPlaneHeal: (() => void) | null = null
  // THE RESTART (the version handshake's heal): armed by restart-when-idle
  // while workers are live, fired by the beat below once none remain;
  // restartAfterTeardown makes the teardown spawn the successor.
  let restartArmed = false
  let restartAfterTeardown = false
  let stopArmedBeat: (() => void) | null = null
  // SATURN (the scheduler reborn): the session-schedule fire engine's stop,
  // armed once the control layer is up (its delivery IS the dispatch door).
  let stopSaturnTicker: (() => void) | null = null
  let roster: TaskRoster | null = null
  // The workers' inbox→stdin dispatch drains — SUBSCRIPTION-driven (no fixed
  // polls). Disposed on shutdown. Declared here so shutdown reaches them.
  const dispatchDrains: DispatchDrainHandle[] = []
  // The roster's busy→idle nudges: on a worker's turn end / fresh spawn,
  // deliver any held dispatch immediately.
  const idleNudges = new Map<string, () => void>()
  // Owner-orphan self-reap poll (armed only for an AUTO-STARTED daemon that
  // carries the owner-pid stamp); cleared on shutdown. ownerWatch.ts explains why.
  let ownerWatch: ReturnType<typeof setInterval> | undefined
  let ready = false
  const startedAt = Date.now()
  // Assigned by the shutdown Promise below; called by the control `shutdown` RPC
  // (which always arrives long after setup, so the binding is set by then).
  let requestShutdown: (signal: string) => void = () => {}
  // per-config-home mutex. Acquire BEFORE the control layer
  // binds, so a 2nd `mercury daemon` (or a racing auto-start double-spawn)
  // for the same config home can't unlink the live socket / overwrite control.key
  // and orphan the running daemon. On contention we refuse + exit cleanly, never
  // touching the live daemon's control files.
  let supervisorLock: SupervisorLock | null = null
  // flipped by the graceful async teardown the moment our on-disk
  // records are cleared (BEFORE the lock release, so the exit backstop can
  // never race a successor daemon's fresh records).
  let teardownComplete = false

  if (controlEnabled) {
    supervisorLock = await acquireSupervisorLock()
    // A SUCCESSOR (restart-when-idle spawned us before releasing its lock)
    // waits for the predecessor's release instead of walking away — the
    // bounded wait is what keeps the restart from racing a screen's spawn.
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
    // SYNC last-resort teardown on process 'exit' — covers the
    // force-exit bails (the wedged-teardown process.exit paths) where the
    // async teardown never ran to completion. We own supervisor.lock from
    // this line on, so the unlinks can only ever touch OUR records.
    // TerminateProcess/SIGKILL fire no exit event at all — that case is the
    // boot-time reconcile's job (reconcileRecords.ts).
    process.once('exit', code => {
      if (!teardownComplete) supervisorExitTeardownSync('exit-before-teardown', code)
    })
    try {
      roster = new TaskRoster({
        dir,
        breaker,
        maxInflight: MAX_INFLIGHT,
        // (the ask-wire): a switchboard child's permission
        // asks (can_use_tool control_requests under --permission-prompt-tool
        // stdio) become durable needs-you obligations; the answer rides
        // concourseControl 'answer-permission' back through the child's
        // control channel.
        onControlRequest: (short, frame) => {
          try {
            // The roster is assigned by the time any child frame drains;
            // it is the expiry's delivery channel (rider R4).
            onWorkerControlRequest(short, frame, undefined, roster ?? undefined)
          } catch (e) {
            logForDebugging(`[daemon] onControlRequest(${short}) hook threw (ignored): ${e}`)
          }
        },
        // The session seat: a session worker's facts answers, init frame
        // and ask cancels ride every stdout line (the seat's own hook).
        onChildLine: (short, line) => {
          if (!short.startsWith('concourse-w') || roster === null) return
          // The warm pool's claim acknowledgements ride the same drain
          // (their request-id prefix is theirs alone — no seat crosstalk).
          onWarmRunnerLine(line)
          onSeatLine(short, line, roster)
        },
        // A long-lived worker that exhausts its respawn budget flips a loud
        // degraded marker (the /substrate snapshot reads getSupervisorState).
        onDegraded: (reason, short) => {
          // eslint-disable-next-line no-console
          console.error(`[daemon] ⚠️  SUPERVISOR DEGRADED — ${reason}`)
          // R7 C-LOW-1: a Concourse worker that exhausts its respawn budget
          // must settle its durable record — otherwise the board paints
          // 'starting' forever and the seat stays consumed. The storm note
          // already carries the loud room line; this is the record truth.
          if (short !== undefined && short.startsWith('concourse-w')) {
            try {
              settleConcourseWorker(short)
            } catch {
              /* record projection only */
            }
            // The DISPATCH truth settles beside the worker's (TASK-014
            // w5-f08-02): the row moves to 'failed' carrying this reason,
            // so the board says WHY instead of 'working' forever.
            try {
              failWorkingDispatchesForRunner(short, reason)
            } catch {
              /* record projection only */
            }
          }
        },
        // Explicit busy→idle transition (replaces observed-by-next-tick): run the
        // per-worker nudge — auto-clear governor + immediate held-dispatch drain.
        // A session worker's idle edge also lands its parked model switch
        // and refreshes its facts (the seat's settlement moment).
        onIdle: short => {
          idleNudges.get(short)?.()
          if (short.startsWith('concourse-w') && roster !== null) {
            // A park requested mid-turn completes here: the runner's own
            // turn is done, so it retires into parked (the close state).
            if (completeRequestedPark(short, roster)) {
              // eslint-disable-next-line no-console
              console.error(`[daemon] ${short} finished its turn and parked (a park was requested while it worked)`)
            }
            onSeatIdle(short, roster)
          }
        },
      })
      // A daemon boot starts with no parked ask and no live child: the seat
      // projections of the previous life are stale by construction.
      resetSeatProjections(dir)
      // Sweep #2, B5.6 (RULED conditional): the operator's optional
      // child-memory limit. Inert unless MERCURY_CHILD_RSS_LIMIT_MB is set;
      // the sweep timer is unreferenced, so teardown owes it nothing.
      armChildRssWatchdog(roster)
      const controlKey = await mintControlKey()
      // The warm-runner pool's one deps object — shared by the claim inside
      // admission, the concourseWarm RPC, the boot self-warm and the idle
      // sweep. The TaskRoster is the pool's roster port structurally.
      const warmDeps = {
        roster: () => roster ?? undefined,
        onWarmSpawned: (short: string, workspaceId: string, pid: number | undefined) => {
          // eslint-disable-next-line no-console
          console.error(
            `[daemon] warm runner pre-spawned: ${short} (pid ${pid}) for ${workspaceId} — unclaimed, model-agnostic, no record`,
          )
        },
      }
      // The two warm doors every admit handler carries (claim-over-spawn +
      // the re-warm after a claim).
      const warmAdmitDoors = {
        claimWarm: (args: Parameters<typeof claimWarmRunner>[0]) => claimWarmRunner(args, warmDeps),
        // The rewarm carries the kit the claim (or its decline) hoisted —
        // the pool re-arms wearing what the operator's births carry, so
        // the next claim's equality gate hits (the warm-claim kit gate).
        ensureWarm: (workspaceDir: string, kit?: Parameters<typeof ensureWarmRunner>[0]['kit']) => {
          void ensureWarmRunner({ workspaceDir, ...(kit !== undefined ? { kit } : {}) }, warmDeps).catch(() => {})
        },
      }
      // Drive-11: ONE dispatch door, shared by the RPC dep below AND the
      // git-ready replay (answer-permission) — the replay must ride the same
      // idempotent handler, never a parallel path.
      const concourseDispatchHandler = makeConcourseDispatchHandler({
        admit: makeConcourseAdmitHandler({
          roster: () => roster ?? undefined,
          ...warmAdmitDoors,
          onSpawned: (runnerId, spec, pid) => {
            // eslint-disable-next-line no-console
            console.error(
              `[daemon] concourse worker admitted: ${runnerId} (pid ${pid}) — ${spec.model}@${spec.effort}, cwd ${spec.cwd}`,
            )
            // The seat resets and publishes the record's facts at once — a
            // CLAIMED warm runner's cached pre-claim answer (default model,
            // spawn posture) must never paint as the session's; the fresh
            // request lands the claimed truth.
            if (roster !== null) onSeatSpawned(runnerId, roster)
          },
        }),
        deliver: async (runnerId, prompt) => {
          if (!roster) return false
          const delivered = await roster.reply(runnerId, prompt)
          // The seat's facts follow the delivery at once — the request
          // queues on the child's stdin right behind the delivered frame, so
          // the answer already carries the words in the session's own queue.
          if (delivered && runnerId.startsWith('concourse-w')) requestSessionFacts(runnerId, roster, { immediate: true })
          return delivered
        },
        // Live-drive ruling: a crash-dead target revives in
        // place before delivery instead of refusing 'target-not-live'.
        revive: async sessionId => {
          const out = reviveConcourseWorker(sessionId, 'auto-revive', roster ?? undefined)
          return out.outcome === 'applied' || out.outcome === 'noop'
            ? { ok: true }
            : { ok: false, error: out.detail ?? out.reason }
        },
      })
      // The idleness the handshake and the restart read: live rostered
      // workers with the warm runners set aside (a pre-booted, unclaimed
      // runner is cache, not work — the successor re-warms it).
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
        // `envelope` fast path: after journaling, deliver to the recipient's
        // drain immediately (agent shorts and inbox names coincide on this bus).
        nudgeAgent: agentName => idleNudges.get(agentName)?.(),
        // CREW TEAMMATES (/teammates, op 'crewSpawn'): on-demand long-lived
        // collaborators. ALL spawn policy lives in crewSpawn.ts
        // (makeCrewSpawnHandler: gate → name → model → dupe → spend cap → team
        // file → registerLongLived — a proof drives the real handler); this is
        // only the drain/nudge wiring. Every refusal is a plain string the
        // board surfaces verbatim (failure ≠ silence).
        crewSpawn: makeCrewSpawnHandler({
          roster: () => roster ?? undefined,
          dir,
          onSpawned: (name, spec, pid) => {
            const r = roster
            if (!r) return
            // Same drain shape as every other back agent: the inbox
            // subscription delivers operator messages (plain frames arrive
            // attributed); dedup by request_id; busy→idle nudges deliver held
            // messages immediately.
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
        // SESSION CONCOURSE: the supervisor ops. ALL
        // admission policy lives in concourseSupervisor.ts (RR-01
        // canonicalization → the five-lease fold → durable worker records →
        // registerLongLived with the CH-01-stripped spec); this block is only
        // the roster/record composition. Session workers are ordinary
        // long-lived stream-json children — the roster's drain keeps their
        // stdout hot (the stdout-drain law) exactly like every other worker.
        // Records live in daemonDir() (the DEFAULT — never the project dir):
        // admit/dispatch/list/release/reconcile must all read ONE home, and
        // the live battery caught exactly the split-home class here.
        concourseAdmit: makeConcourseAdmitHandler({
          roster: () => roster ?? undefined,
          ...warmAdmitDoors,
          onSpawned: (runnerId, spec, pid) => {
            // eslint-disable-next-line no-console
            console.error(
              `[daemon] concourse worker admitted: ${runnerId} (pid ${pid}) — ${spec.model}@${spec.effort}, cwd ${spec.cwd}`,
            )
            // The seat publishes the record's facts at once and asks the
            // child for its own (answered once its stdin loop is up).
            if (roster !== null) onSeatSpawned(runnerId, roster)
          },
        }),
        concourseDispatch: concourseDispatchHandler,
        // SB-C6: the x gesture's ledger write rides the SAME mutex tail.
        concourseWithdraw: clientMessageId => concourseDispatchHandler.withdraw(clientMessageId),
        // The warm-runner pool's arming door (the screen's mount hook and
        // any workspace switch) + the status op's honest count.
        concourseWarm: req => ensureWarmRunner(req, warmDeps),
        warmRunnerCount: () => warmRunnerCount(),
        concourseList: () => {
          if (!roster) return []
          const entries = roster.list().filter(j => !j.outcome)
          const live = new Set(entries.map(j => j.short))
          const livePid = new Map(entries.map(j => [j.short, j.pid]))
          // Records carry the SPAWN-TIME pid; the roster carries the LIVE one
          // (a crash-respawn re-points it). The summary surfaces roster truth —
          // process facts from the process owner, relationships from records.
          return listConcourseWorkers(live).map(r => ({
            ...r,
            // Legacy mirror for proto≤2 row readers — dropped at proto 4.
            workerId: r.runnerId,
            ...(livePid.get(r.runnerId) !== undefined ? { pid: livePid.get(r.runnerId) } : {}),
          })) as unknown as ReadonlyArray<Record<string, unknown>>
        },
        concourseRelease: runnerId => {
          const killed = roster ? roster.kill(runnerId) : false
          // endedAt's contract is "worker settled" — never end a record whose
          // child is alive with no kill dispatched (the restart-divergence
          // orphan): the row would leave the board while the process runs on
          // invisibly. The typed {settled:false, killed:false} receipt keeps
          // the row until a kill channel exists.
          if (!killed) {
            const rec = readSessionWorkers()[runnerId]
            if (rec?.endedAt === undefined && rec?.pid !== undefined && isProcessAlive(rec.pid)) {
              return { settled: false, killed: false }
            }
          }
          const settled = settleConcourseWorker(runnerId)
          // R7 C-LOW-1: the admission slot pick requires the short to be
          // ABSENT from the roster, but a released long-lived handle lingers
          // settled forever (reapSettled only runs on the one-shot dispatch
          // path) — every release would permanently consume a seat slot. A
          // deferred second kill reaps the handle once handleCrash settles it.
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
        // The /rewind verb (v5): the session's own runner adjudicates and
        // answers; the seat awaits it under a deadline and every arm of
        // the road speaks the typed refusal vocabulary.
        sessionRewind: async req => {
          if (roster === null) {
            return { outcome: 'refused' as const, mode: req.mode, refusal: 'no-channel' as const, detail: 'daemon roster not ready' }
          }
          return rewindSession(req.sessionId, { mode: req.mode, userMessageId: req.userMessageId, ...(req.dryRun === true ? { dryRun: true } : {}) }, roster)
        },
        concourseControl: ({ action, sessionId, by, reason, hard, requestId, allow, answer, model, effort, mode, contract, kitEdit, scheduleEdit, clientOpId, mintedAtMs, title, titleSource }) => {
          // Resolve the worker FROM its session identity —
          // the valve speaks session ids (the operator's vocabulary), the
          // records speak worker shorts. Typed refusal when no record owns
          // the session. The reason rides the receipt only (the record
          // stores pausedBy; pause is a state, not a message).
          void reason
          // Advisor item 8: the applied-ops ledger makes control exactly-
          // once under retry-after-response-loss — a replayed clientOpId
          // returns the FIRST receipt without re-executing (interrupt would
          // otherwise abort a second turn).
          if (clientOpId !== undefined) {
            const prior = readConcourseControlOps()[clientOpId]
            // A hit requires the FULL intent match — a record minted for a
            // different action/session is a miss, never a foreign receipt
            // (pre-field rows lack the fields and also read as misses).
            if (prior && prior.action === action && prior.sessionId === sessionId)
              return { outcome: prior.outcome, ...(prior.detail !== undefined ? { detail: prior.detail } : {}) }
          }
          const settle = (r: { outcome: 'applied' | 'noop' | 'refused'; detail?: string }): typeof r => {
            // Containment: the op has ALREADY executed by the time the
            // ledger records it — a failed write (ENOSPC, perms) must never
            // convert an applied op into an error reply, which would make
            // the caller release its identity and re-execute (the exact
            // double-abort the ledger exists to prevent).
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
            // Q2 + ruling 3: keyed by
            // requestId ALONE — a git-init offer is FOLDER-scoped
            // (sessionId 'folder:…' owns no worker record), and the old
            // record gate below bounced every answer 'unknown-session':
            // the operator's yes literally had no door.
            if (requestId === undefined || requestId === '') {
              return { outcome: 'refused' as const, detail: 'answer-permission requires requestId' }
            }
            return answerPermissionAsk(
              requestId,
              allow === true,
              roster ?? undefined,
              by,
              {
                // Drive-11: git landed — start the launches that waited on it,
                // through the ONE dispatch door (same reservations, idempotent).
                // The sync projection names them in this receipt; the replay
                // itself settles the rows the board reads.
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
                // THE RULED No LEG (board controls item 5): a deny proceeds
                // lawfully — the gated replay starts the oldest DEFAULTED
                // launch where the folder is free (exclusive, alone); a held
                // folder starts nothing and the receipt says the queued truth.
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
              // The consent card's FULL answer (the card's input, the rules it
              // offered, the deny reason, the abort's interrupt).
              answer as Parameters<typeof answerPermissionAsk>[5],
            )
          }
          if (action === 'park-all') {
            // CLOSE-ALL from a quitting screen: every session this terminal
            // was running parks (idle at once, mid-turn after its own turn,
            // newborns released); a chat another LIVE terminal is looking
            // at is theirs and stays. State-idempotent — no ledger row.
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
            // THE CLOSE STATE's one writer: the operator closed this chat.
            // An idle runner dies now and the record parks; a runner
            // mid-turn finishes its own turn first ('draining' — the idle
            // edge completes the park); a newborn is released instead.
            const out = parkConcourseSession(sessionId, by, roster ?? undefined)
            return out.outcome === 'refused'
              ? { outcome: 'refused' as const, detail: out.detail ?? out.reason }
              : out.outcome === 'noop'
                ? { outcome: 'noop' as const, detail: out.reason }
                : out.outcome === 'draining'
                  ? { outcome: 'draining' as const, detail: `${out.runnerId} finishes its turn, then parks` }
                  : { outcome: 'applied' as const, detail: out.released ? `released newborn ${out.runnerId}` : `parked ${out.runnerId}` }
          }
          // The seat verbs — what the focused chat needs from a session the
          // daemon hosts. Each answers a typed outcome; none opens a turn.
          // State-idempotent by construction (a switch to the model the
          // session runs no-ops; a removed uuid stays removed), so none
          // rides the applied-ops ledger; a parked switch answers 'queued'.
          if (action === 'set-title') {
            // SESSION-AWARE NAMING (L16): the record's one title writer —
            // an operator title always lands; a minted one fills an empty
            // slot only and stamps once (the laws live in the verb).
            return settle(setConcourseSessionTitle(sessionId, title ?? '', by, titleSource === 'minted' ? 'minted' : 'operator'))
          }
          if (action === 'contract') {
            // THE ADVISORY CONTRACT's one door (coordinator-tooling ledger
            // T1–T6): op set|ack|amend|close, adjudicated at the record's
            // one writer (sessionContract.ts). Advisory always — this arm
            // writes agreement state and never touches valves, tools or
            // admissions. Rides settle so an agent's retried ack/close
            // stays exactly-once under a lost response.
            if (contract === undefined) return { outcome: 'refused' as const, detail: 'contract requires { contract: { op, text? } }' }
            return settle(applyConcourseContractOp(sessionId, contract, by))
          }
          if (action === 'set-schedule') {
            // SATURN's one door (daemon/saturn.ts): op add|remove|pause|
            // resume, adjudicated at the record's one writer. THE FOUNDING
            // LAW wires here: the account is DERIVED from the session's own
            // resolution (saturnAccount.ts — never the wire's claim) and
            // the schedule-time preflight runs THE ONE VERDICT function
            // over live credential facts, stamped as provenance. Applied/
            // noop/refused ride settle (exactly-once under a lost
            // response); receipts row at the writer (kind 'schedule-set').
            if (scheduleEdit === undefined) return { outcome: 'refused' as const, detail: 'set-schedule requires { scheduleEdit: { op, schedule? | scheduleId? } }' }
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
            // THE KIT'S ONE WRITER + THE LIVE FORWARD (ledger
            // L24(3)): the seat half adjudicates — idle: the record's writer
            // applies (a pre-kit record materializes first) and the
            // post-edit kit forwards whole to the child (kit_edit); busy:
            // the edit parks on the record and drains at the next lawful
            // beat, the caller hearing the honest 'queued' line. Applied/
            // noop/refused ride settle (exactly-once under a lost
            // response); a queued park is by-value idempotent — a replayed
            // dial re-parks an edit whose re-apply noops.
            if (kitEdit === undefined) return { outcome: 'refused' as const, detail: 'set-kit requires { kitEdit: { mcp?, skills?, extensions? } }' }
            if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
            const dialed = setSessionKitDial(sessionId, kitEdit, by, roster)
            return dialed.outcome === 'queued'
              ? dialed
              : settle({ outcome: dialed.outcome, ...(dialed.detail !== undefined ? { detail: dialed.detail } : {}) })
          }
          if (action === 'set-model') {
            if (model === undefined || model === '') return { outcome: 'refused' as const, detail: 'set-model requires model' }
            return roster !== null ? setSessionModel(sessionId, model, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-effort') {
            // set-model's effort sibling — the identical arm (poison: an
            // effort write without the field).
            if (effort === undefined || effort === '') return { outcome: 'refused' as const, detail: 'set-effort requires effort' }
            return roster !== null ? setSessionEffort(sessionId, effort, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'set-permission-mode') {
            if (mode === undefined || mode === '') return { outcome: 'refused' as const, detail: 'set-permission-mode requires mode' }
            return roster !== null ? setSessionPermissionMode(sessionId, mode, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'session-facts') {
            return roster !== null ? refreshSessionFacts(sessionId, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
          }
          if (action === 'focus' || action === 'blur') {
            // THE FOCUS FACT's one writer (Law 9 rule 4 made durable). Its
            // callers: the hop — the connector says focus as it attaches and
            // blur as it loses the slot — and one-door's create-on-Enter,
            // which births a session born-and-focused through this verb,
            // never a second writer. State-idempotent (a re-focus no-ops),
            // so no ledger row; the record is the truth the runner's
            // launch-authority valve reads.
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
            // R4: abort the worker's CURRENT turn via its own -p control
            // path (control_request → abortController, and the same stop
            // for every background agent the turn waits on). Never a valve
            // change; the worker stays live for the next delivery. The
            // worker leg binds to the SAME identity so a ledger miss (crash
            // between execute and record) still converges.
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
              // THE HARD STOP (the second esc): a runner that has not closed
              // its turn a second after the interrupt is cut — SIGTERM to
              // its tree, which the runner answers by settling the turn's
              // interruption rows before it exits. The record keeps no stop
              // stamp: the session survives and its next words revive it.
              // The seat's facts publish once the child is gone (the exit
              // fires no idle edge), so the chat's busy fact falls with it.
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
          if (action === 'stop') {
            // Operator x-gesture: kill the child, keep the record visible
            // as stopped (the second x rides concourseRelease).
            const out = stopConcourseSession(sessionId, by, roster ?? undefined)
            return out.outcome === 'refused'
              ? { outcome: 'refused' as const, detail: out.reason }
              : out.outcome === 'noop'
                ? { outcome: 'noop' as const, detail: out.reason }
                : { outcome: 'applied' as const, detail: `stopped ${out.runnerId}` }
          }
          if (action === 'attach') {
            // (enter = one-terminal full swap): close the
            // valve, drain any in-flight turn (the caller watches the delta
            // stamp and re-requests), kill the child at the boundary, stamp
            // attachedAt. Idempotent by state — no applied-ops ledger row.
            const out = attachYieldConcourseSession(sessionId, by, roster ?? undefined)
            return out.outcome === 'refused'
              ? { outcome: 'refused' as const, detail: out.detail ?? out.reason }
              : { outcome: out.outcome, detail: out.runnerId }
          }
          if (action === 'detach') {
            // W2 leave: clear attachedAt, re-open the valve (the lawful
            // resume grammar — held rows replay caller-side through the
            // idempotent dispatch door), respawn the SAME durable session.
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
            // W3: the ONE standing workflows-allowed tag (operator-ruled).
            const out =
              action === 'grant-workflows'
                ? grantConcourseWorkflows(sessionId, by)
                : revokeConcourseWorkflows(sessionId, by)
            if (action === 'grant-workflows' && out.outcome === 'applied' && roster !== null) {
              // Fix 1c: the session learns its hands grew —
              // without this the tag flip is invisible until the next
              // instruction. A dead/attached worker delivers nothing
              // (false), which is fine: the spawn posture line + per-turn
              // tool gating cover it on respawn.
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
          // action === 'resume': open the valve, then make 'applied' TRUE —
          // a dead runner revives in place (same session, same chat) instead
          // of a success receipt on a corpse (live-drive friction:
          // redirect refused → resume 'applied' → redirect refused again).
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
          // Reap live workers if asked, then trigger process shutdown.
          // Returns WHO was reaped — name and purpose — so /halt reports
          // "crew seat" instead of a bare count, and a worker already
          // 'retiring' from an earlier reap is never counted again (the
          // second-halt-reaped-4-more class).
          const workers: ReturnType<NonNullable<typeof roster>['liveWorkerFacts']> = []
          if (reapWorkers && roster) {
            for (const w of roster.liveWorkerFacts()) {
              if (roster.kill(w.short)) workers.push(w)
            }
          }
          // Defer the actual teardown so this RPC reply flushes first.
          setImmediate(() => requestShutdown('control:shutdown'))
          return { reaped: workers.length, workers }
        },
        // THE HANDSHAKE's facts: the version this process booted as, its
        // posture, and its idleness — the client compares and decides.
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
        // THE HEAL: re-execute as the deployed build now (idle) or at the
        // next idle moment (armed). Two typed refusals: a terminal daemon,
        // and a successor that came back unchanged inside the storm guard
        // — the bundle at our own script path is what a restart runs.
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
      // THE IDENTITY BASELINE (TASK-017 F-1): the record carries this
      // process's own start token so the boot-time reconcile can tell THIS
      // pid from a recycled stranger through the ONE start-token vocabulary
      // (never a second liveness test). Async — the win32 probe is a CIM
      // spawn the boot must not block the event loop on; null (probe could
      // not answer) reads conservatively everywhere.
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
      // Fix 3: a LIVE daemon whose
      // control plane vanished from under it (a dying predecessor's unlink
      // race, a client's too-eager dead-daemon clearance) re-creates it
      // within a beat — key, ownership record, then the socket re-bind.
      // Backs off only when a DIFFERENT live pid provably owns the plane.
      {
        const planeHeal = setInterval(() => {
          void (async () => {
            try {
              const { existsSync, readFileSync } = await import('node:fs')
              // WIN-1: a named pipe cannot be unlinked from under its
              // listener — the file-deletion class does not exist for the
              // socket on win32 (existsSync on \\.\pipe\ names is also
              // unreliable); the key/state halves are regular files there
              // and keep the heal.
              const sockMissing =
                process.platform === 'win32' ? false : !existsSync(controlSockPath())
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
              if (foreignOwner) return // a live successor owns the plane — never steal it back
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
              logForDebugging(`[daemon] plane self-heal failed (next beat retries): ${e}`)
            }
          })()
        }, 4000)
        planeHeal.unref?.()
        stopPlaneHeal = () => clearInterval(planeHeal)
      }
      // The armed restart's beat: restart-when-idle answered 'armed' while
      // work was running; once no live worker remains (warm runners never
      // hold it) the daemon re-executes itself as the deployed build.
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
      // eslint-disable-next-line no-console
      console.error('[daemon] control socket up — RPC: list/has/status/dispatch/reply/kill/shutdown')
      // SATURN's fire engine: the ticker walks the live session records and
      // fires their schedules through the ONE dispatch door (live targets
      // ride targetSessionId; parked 'wake' fires ride resumeSessionId —
      // the resume door reactivates and delivers in one idempotent call).
      // The birth tier rides makeSaturnBirthPort below (S5); a refused
      // birth banks 'admission-refused' typed and retries. Kill switch:
      // MERCURY_SATURN_DISABLE (registered).
      stopSaturnTicker = startSaturnTicker(
        {
          now: () => Date.now(),
          records: () => Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined),
          liveFacts: account => readLiveAccountFacts(account),
          // THE FIRE-TIME DERIVATION (SF1 ruling b): the account that will
          // actually serve the fire — the same owner the writers read.
          deriveAccount: modelKey => deriveScheduleAccountForModel(modelKey),
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
          // THE BIRTH TIER (saturnBirth.ts): born-working rides the ONE
          // dispatch door (a held launch is withdrawn and banked in
          // SATURN's own held-fire road — one owner of a pending birth);
          // born-waiting rides the admission door bornBlank. The contract
          // pre-answer and the "born by schedule" receipt land after the
          // door answers.
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
      // THE BOOT SELF-WARM (the warm-runner pool): an OWNED daemon — one a
      // screen spawned after its first paint, owner-pid stamped — pre-warms
      // the ONE runner for its boot workspace at once, so the runner's init
      // overlaps the operator's first words instead of following them. An
      // explicitly-run `mercury daemon` (no owner) never self-warms; the
      // screen's concourseWarm call arms the pool there instead. A boot
      // that carries runner-side options stamps MERCURY_DAEMON_NO_SELF_WARM
      // on this spawn (ensureDaemon.ts): its sessions spawn cold with the
      // flags, so a warm runner could never serve them.
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
      // converge concourse worker records against the fresh
      // roster (a daemon restart orphans no lease — a record whose worker
      // died with the old daemon settles exactly once; its durable session
      // resumes only by explicit re-admission, never by silent respawn).
      {
        const liveShorts = new Set(
          roster ? roster.list().filter(j => !j.outcome).map(j => j.short) : [],
        )
        reconcileConcourseWorkers(liveShorts)
        // R7 C-LOW-1: converge mid-life too (the boot-only reconcile left a
        // worker that died between boots painting 'starting' with its seat
        // consumed until the next daemon restart). The reconciler's own
        // contract: conservative, safe to re-run at any time.
        const reconcileTick = setInterval(() => {
          try {
            const live = new Set(
              roster ? roster.list().filter(j => !j.outcome).map(j => j.short) : [],
            )
            reconcileConcourseWorkers(live)
          } catch {
            /* projection only */
          }
          // Sweep #2 rider R5: the idle-retirement owner rides the
          // same minute tick — empty idle sessions past the threshold stop
          // with a typed fact the board paints.
          try {
            sweepIdleEmptyConcourseSessions(roster ?? undefined)
          } catch (e) {
            logForDebugging(`[daemon] idle retirement sweep threw (ignored): ${e}`)
          }
          // The warm-runner pool idles on the same tick, under its own
          // shorter budget (an unclaimed process holds providers open).
          try {
            sweepIdleWarmRunners(warmDeps)
          } catch (e) {
            logForDebugging(`[daemon] warm runner sweep threw (ignored): ${e}`)
          }
        }, 60_000)
        reconcileTick.unref?.()
      }
    } catch (e) {
      // LOUD, not just the debug channel: a boot error here silently killed the
      // whole roster block (the EINVAL sun_path bind — the daemon "ran" for
      // 91s with no control socket and no seats, and the only trace was a
      // debug-file line). An operator/harness watching stderr must see WHY
      // the daemon is degraded.
      // eslint-disable-next-line no-console
      console.error(
        `[daemon] ⚠️  control layer FAILED to start — continuing as pure cron daemon (no roster): ${e}`,
      )
      logForDebugging(`[daemon] control layer failed to start (continuing as pure cron daemon): ${e}`)
      controlServer = null
      roster = null
    }
  }

  return new Promise<void>(resolveShutdown => {
    // Keepalive: the scheduler's own timers are unref'd (so they don't hold the
    // event loop), which is correct for -p mode but would let the daemon exit
    // immediately. This ref'd, ever-pending timer is the explicit "stay alive
    // until a signal" anchor; cleared on shutdown.
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
      // Stop the dispatch bridge drains so their watchers + retry timers
      // never outlive the daemon.
      for (const d of dispatchDrains.splice(0)) {
        try {
          d.dispose()
        } catch (e) {
          logForDebugging(`[daemon] drain dispose failed (ignored): ${e}`)
        }
      }
      idleNudges.clear()
      if (ownerWatch) {
        clearInterval(ownerWatch)
        ownerWatch = undefined
      }
      // Reap live rostered workers (incl. the long-lived seats) so a
      // signal shutdown never orphans a supervised child. roster.kill() marks a
      // long-lived worker intentional-stop, so it exits cleanly without respawn.
      // Each reap lands a SYNC ledger row FIRST: the process exits
      // ~250ms after this, so the child's own 'exit' event (which would write
      // the exit row) may never be observed — the reap row is the guaranteed
      // record that the daemon killed it on the way down.
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
      // Tear the control layer down: close the socket and clear the supervisor
      // record so a later `status`/`stop` sees an honest "not running".
      void (async () => {
        try {
          await controlServer?.close()
        } catch (e) {
          logForDebugging(`[daemon] error closing control server: ${e}`)
        }
        // KEY FIRST, THEN THE RECORD: both clears are ownership-checked against
        // supervisor.json, so clearing the record first made clearControlKey's
        // guard read false and the key outlived EVERY clean shutdown — the next
        // boot's reconcile then reported 'removed control.key' as stale debris the
        // shutdown itself had left (TASK-017 S2, control-key-never-cleared).
        if (controlEnabled) await clearControlKey().catch(() => {})
        if (controlEnabled) await clearSupervisorState().catch(() => {})
        // The supervisor's own teardown record: one ledger row per
        // daemon life-end, written on the graceful path here; the sync exit
        // backstop writes the same row for exit-before-teardown deaths.
        recordSpawnExit({
          kind: 'supervisor',
          event: 'exit',
          id: 'supervisor',
          pid: process.pid,
          reason: `shutdown:${signal}`,
        })
        // Flag BEFORE the lock release: from here the exit backstop is a
        // no-op, so it can never unlink a successor daemon's fresh records
        // (a successor can only acquire after the release below).
        teardownComplete = true
        // THE RESTART's successor: spawned BEFORE the lock release with the
        // predecessor named, so it waits for the lock (never walks away)
        // and no screen's spawn slips in between. Same argv, env and cwd —
        // the owner-pid stamp rides along, so an owned daemon stays owned
        // and a persistent one persistent; the log fds are inherited.
        if (restartAfterTeardown) spawnSuccessorDaemon()
        // Release the supervisor mutex LAST (after the socket is closed + state
        // cleared) so the next daemon for this config home can start cleanly.
        // Routed through shutdown(), so this covers SIGINT/SIGTERM, the control
        // `shutdown` RPC, the owner-orphan self-reap, AND crashShutdown.
        await supervisorLock?.release().catch(() => {})
        supervisorLock = null
        clearInterval(keepAlive)
        resolveShutdown()
        // A COMPLETE teardown must exit promptly and cleanly. Observed
        // (bench daemon-smoke diagnostic): some library handle
        // keeps the loop referenced after every teardown step has finished —
        // seats dead ≤1s, disengage+lane-release+socket-close done ≤2s — so
        // the process idled until the 15s bail force-exited EVERY clean
        // shutdown with code 1. Exit 0 here, one tick after the shutdown
        // promise resolves (its awaiters run first); the bail below stays as
        // the wedged-teardown failsafe.
        setTimeout(() => process.exit(0), 250)
      })()
      // Failsafe: if the async teardown above wedges (a hung lane-release git
      // call, a dead disk), force-exit rather than zombie behind the keepAlive
      // anchor. Unref'd so a clean drain is never held up; 15s is far beyond
      // any healthy teardown.
      const bail = setTimeout(() => process.exit(1), 15_000)
      bail.unref?.()
    }
    // CLOSE-ALL AT THE ORPHAN REAP (the control-plane model, law 3): the
    // screen that owned this daemon is gone, so every active session PARKS
    // — idle ones at once, mid-turn ones after their own turn (the roster's
    // idle edge completes each park; the registered drain ceiling bounds
    // the wait, and a turn still running past it is cut with the reason on
    // its row), newborns released — and only then does the daemon go down.
    // The next boot's reconcile finds PARKED records, never crash rows: a
    // closed chat is parked, not lost. Latched — the owner watch keeps
    // firing while the drain runs.
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
    // The daemon OWNS its signals — setupGracefulShutdown skips its signal arms
    // for the daemon subcommand (its process.exit would race this async
    // teardown), so SIGHUP (terminal close on an explicitly-run daemon) must be
    // handled here or it hard-kills with no teardown at all.
    process.on('SIGHUP', () => shutdown('SIGHUP'))
    // Ctrl+Break on an explicitly-run daemon (CTRL_BREAK_EVENT ⇒ SIGBREAK on
    // win32): unhandled it hard-killed with no teardown, exactly like the
    // console close above (FN-015 rank 21).
    process.on('SIGBREAK', () => shutdown('SIGBREAK'))

    // R5c — crash guard: an uncaught exception / unhandled rejection in the daemon
    // must NOT leave the long-lived workers, the control socket, and the
    // supervisor record orphaned. Run the SAME graceful teardown as a signal
    // (reap workers → clear polls → close socket → clear state), then exit non-zero.
    // shutdown() is re-entrancy-guarded, so a fault mid-shutdown is safe; the unref'd
    // failsafe force-exits if the async teardown ever wedges (never hang a dead daemon).
    const crashShutdown = (label: string, err: unknown): void => {
      // eslint-disable-next-line no-console
      console.error(`[daemon] ${label} — reaping workers + control socket, then exiting:`, err)
      // The unified archive (crash-archive census): the daemon's crashes
      // previously left forensics ONLY in the per-project daemon.log — a
      // differently-located, differently-shaped trail from the
      // ~/.mercury/crashes archive every crash surface points users at.
      // The report joins the one archive; the log keeps its copy.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('../utils/crashReport.js') as typeof import('../utils/crashReport.js')
        crashMod.persistCrashReport(err, undefined, label === 'uncaughtException' ? 'uncaught-exception' : 'unhandled-rejection')
      } catch {
        // Forensics, never a dependency of the reap.
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

    // Owner-orphan self-reap: an AUTO-STARTED daemon (spawnOwnedDaemon stamps
    // the owner pid) shuts itself down once the spawning session is absent —
    // the robust backstop for the parent reaper that SIGHUP/SIGKILL bypass, so
    // a closed CLI never leaves a daemon (with a stale account's auth)
    // running. An explicit `mercury daemon` carries no owner pid ⇒ never arms ⇒
    // persists for cron. Opt out: MERCURY_DAEMON_PERSIST=1. Unref'd so it
    // never itself keeps the
    // process alive (keepAlive is the anchor).
    const ownerPid = parseOwnerPid()
    const persist = isEnvTruthy(flagEnv('MERCURY_DAEMON_PERSIST'))
    if (ownerPid !== null && !persist) {
      let deadStreak = 0
      // R5b — pin the owner's IDENTITY, not just its pid: capture the owner's process
      // start token ONCE at arm (the owner is definitely alive here, so this is the
      // genuine owner's lstart). Each probe then requires BOTH a live pid AND the SAME
      // start token, so a pid the OS recycles within the ~8s grace (a different process
      // now holding the owner's number) reads as gone and the reap proceeds — instead
      // of a false "owner still alive" pinning an orphaned daemon forever.
      const ownerStartToken = getProcessStartToken(ownerPid)
      // The per-probe token query is ASYNC (the win32 sync
      // spawn blocked the daemon's loop 400–900ms every 4s); single-flight
      // so a slow PowerShell can never stack probes.
      let ownerProbeInflight = false
      ownerWatch = setInterval(() => {
        if (ownerProbeInflight) return
        ownerProbeInflight = true
        void (async () => {
          try {
            const ownerAlive =
              isProcessAlive(ownerPid) &&
              ownerIdentityMatches(await getProcessStartTokenAsync(ownerPid), ownerStartToken)
            deadStreak = ownerAlive ? 0 : deadStreak + 1
            if (
              decideOrphanShutdown({
                ownerPid,
                ownerAlive,
                deadStreak,
                graceChecks: OWNER_WATCH_GRACE_CHECKS,
                persist: false,
              })
            ) {
              // eslint-disable-next-line no-console
              console.error(`[daemon] owner pid ${ownerPid} gone — parking every active session, then self-reaping (orphaned auto-start)`)
              void parkAllThenShutdown('owner-orphaned')
            }
          } finally {
            ownerProbeInflight = false
          }
        })()
      }, OWNER_WATCH_INTERVAL_MS)
      ownerWatch.unref?.()
    }
  })
}

/** How long a successor waits for its predecessor's supervisor lock. */
const SUCCESSOR_LOCK_WAIT_MS = 10_000
/** A successor refuses a second restart this soon after coming back — the
 *  bundle on disk did not change, so another re-exec would loop. */
const RESTART_STORM_GUARD_MS = 60_000
/** The armed restart's idle check cadence. */
const ARMED_RESTART_BEAT_MS = 4_000

/**
 * Re-execute this daemon as the deployed build: the same node flags, script
 * and arguments, the same env (plus the predecessor stamp the successor's
 * lock wait reads), the same cwd, the same stdout/stderr (the daemon.log
 * fds of an owned daemon). Detached and unref'd — this process exits a
 * beat later. Never throws; a failed spawn is logged, and the next screen
 * spawns an owned daemon as it always has.
 */
function spawnSuccessorDaemon(): number | undefined {
  try {
    // child-env law: raw base by design — the successor daemon IS Mercury.
    const env: NodeJS.ProcessEnv = { ...process.env, ...flagPair('MERCURY_DAEMON_SUCCESSOR_OF', String(process.pid)) }
    // The gated scrub, at THIS spawn door too (HB-0078, the one-home set
    // shared with ownedDaemon): a restart is the road an env-kept daemon
    // takes to adopt the operator's LATER sign-in — the successor must
    // re-resolve the stored account, never inherit our spawn-time bearer
    // past it. Env-only auth (no store) still keeps the env token.
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
