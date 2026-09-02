import { writeSync } from 'node:fs'

import { onExit } from 'signal-exit'

import { getIsScrollDraining } from '../bootstrap/state.js'
import type { ExitReason } from '../entrypoints/sdk/coreTypes.js'
import type { AppState } from '../state/AppStateStore.js'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { armInactivityDeadline } from './deadline.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { logError } from './log.js'
import { registerProcessOutputErrorHandlers } from './process.js'
import { profileReport } from './startupProfiler.js'

/**
 * Process shutdown: signal and crash handlers, the bounded asynchronous
 * shutdown sequence, and the fire-time bridge to the heavy restoration
 * half (shutdownRestoration.ts).
 *
 * STAGE-1 LAW (prove-boot-contract.ts pins it): cli.tsx evaluates this
 * module at step 9, before ANY routing — LSP sidecars, the daemon and join
 * fast paths included — so its static value closure must stay featherweight.
 * Everything here is either already evaluated by stage 1 (bootstrap/state,
 * debug, startupProfiler ride the step-8 profiler import) or import-free
 * (cleanupRegistry, diagLogs, log, signal-exit, node builtins). The heavy
 * exit-restoration world — ink instances/ledger/termio, the config barrel,
 * session storage — lives in shutdownRestoration.ts and is reached only at
 * fire time: a synchronous require on the exit paths (the signal-exit
 * teardown cannot await), pre-warmed by an idle prefetch on interactive
 * boots so the at-exit require is a cache hit.
 */

export type GracefulShutdownOptions = {
  getAppState?: () => AppState
  setAppState?: (updater: (prev: AppState) => AppState) => void
  /** Written to standard error just before exit. */
  finalMessage?: string
}

const CLEANUP_TIMEOUT_MS = 2000
const FAILSAFE_FLOOR_MS = 5000
const FAILSAFE_HOOK_MARGIN_MS = 3500
const ORPHAN_CHECK_INTERVAL_MS = 30_000
const RESTORATION_PREFETCH_DELAY_MS = 3000

//
// The fire-time bridge to the restoration half
//

type ShutdownRestorationModule = typeof import('./shutdownRestoration.js')

let restorationModule: ShutdownRestorationModule | undefined

/** Synchronous, for the paths inside signal-exit's teardown that cannot
 *  await. The bundler links the require against the bundled module graph
 *  (the stopHooks runtime-require precedent), so in a process that already
 *  loaded the interactive world this is a cache hit. */
function resolveRestorationSync(): ShutdownRestorationModule | undefined {
  if (!restorationModule) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      restorationModule = require('./shutdownRestoration.js') as ShutdownRestorationModule
    } catch (err) {
      logForDebugging(`gracefulShutdown: restoration module require failed: ${String(err)}`)
      return undefined
    }
  }
  return restorationModule
}

// The non-negotiable restorations as hardcoded bytes, duplicated from their
// owners (SHOW_CURSOR / EXIT_ALT_SCREEN in ink/termio/dec.ts — both stable
// escape strings) STRICTLY for the catch arm: they fire only when the
// restoration module itself failed to resolve at exit, and the terminal must
// never be left on the alt screen with a hidden cursor.
// ?2026l FIRST — ink/root/teardown.ts's own first step: a paint killed between
// BSU and ESU must not leave the terminal frozen, and this fallback is the
// cover exactly when that suite never ran (TASK-017 S2, exit-heals-omit-
// synchronized-update-close).
const FALLBACK_CLOSE_SYNC_UPDATE = '\x1b[?2026l'
const FALLBACK_EXIT_ALT_SCREEN = '\x1b[?1049l'
const FALLBACK_SHOW_CURSOR = '\x1b[?25h'

/** Terminal-mode restoration via the heavy owner, with the bytes fallback.
 *  The isTTY gate here is a LOAD gate (a process whose stdout was never a
 *  terminal has nothing to restore and must not evaluate the interactive
 *  world at exit); the owner re-checks it as the behavior gate. */
function runTerminalRestoration(): void {
  if (restorationModule) {
    restorationModule.cleanupTerminalModes()
    return
  }
  if (!process.stdout.isTTY) return
  const restoration = resolveRestorationSync()
  if (restoration) {
    restoration.cleanupTerminalModes()
    return
  }
  try {
    writeSync(1, FALLBACK_CLOSE_SYNC_UPDATE)
    writeSync(1, FALLBACK_EXIT_ALT_SCREEN)
    writeSync(1, FALLBACK_SHOW_CURSOR)
  } catch {
    // The terminal may already be gone.
  }
}

/** The resume hint is cosmetic: skipped outright when the restoration module
 *  cannot be reached (same load gate as the restoration). */
function runResumeHint(): void {
  const restoration =
    restorationModule ?? (process.stdout.isTTY ? resolveRestorationSync() : undefined)
  restoration?.printResumeHint()
}

//
// Forced exit
//

let failsafeTimer: ReturnType<typeof setTimeout> | undefined

function forceExit(exitCode: number): void {
  if (failsafeTimer) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  // Drain LAST, through the instance's own drain (the restoration owner
  // wraps it); never worth loading the interactive world for — an unresolved
  // module here means no renderer ever mounted.
  try {
    const restoration =
      restorationModule ?? (process.stdout.isTTY ? resolveRestorationSync() : undefined)
    restoration?.drainStdinForExit()
  } catch {
    // Ignored.
  }
  try {
    process.exit(exitCode)
  } catch (err) {
    // The terminal is absent and the runtime cannot flush to a dead descriptor.
    if (process.env.NODE_ENV === 'test') throw err
    process.kill(process.pid, 'SIGKILL')
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('forceExit: process.exit returned control')
  }
}

//
// The loud failure
//

const MODULE_LOAD_CODES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_REQUIRE_ESM',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_INVALID_PACKAGE_CONFIG',
  'ERR_DLOPEN_FAILED',
])

/** A module the running artifact cannot load — a packaging or install defect
 *  no session can recover from. */
export function isModuleLoadFailure(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false
  const code = (reason as { code?: unknown }).code
  if (typeof code === 'string' && MODULE_LOAD_CODES.has(code)) return true
  return /^Cannot find (?:module|package) /.test(reason.message)
}

export type LoudFailureOrigin = 'boot' | 'unhandled-rejection' | 'uncaught-exception'

/**
 * The loud exit. A boot that cannot complete must never idle: once a
 * rejection has been swallowed, nothing but the ref'd raw-mode stdin keeps
 * the process alive and no frame is ever painted (the
 * deployed-runtime hang — `undici` absent beside the artifact, the
 * rejection logged once, a blank screen for as long as the operator
 * waited). Synchronous end to end, because the process-level handlers
 * cannot await: persist the report, restore the terminal, print the card
 * — cause, consequence, next, report — and exit 1.
 */
export function failLoud(error: unknown, origin: LoudFailureOrigin): void {
  const err = error instanceof Error ? error : new Error(String(error))
  const moduleFailure = isModuleLoadFailure(err)
  logForDebugging(
    `failLoud(${origin}): ${err.name}: ${truncate(err.message, 2000)}\n${truncate(err.stack ?? '', 4000)}`,
  )
  logForDiagnosticsNoPII('error', 'boot_failed_loud', { origin, moduleFailure })
  let reportPath: string | null = null
  let reportRefusal = 'the config home refused the write'
  try {
    // Fire-time require (the restoration precedent): the report writer must
    // not join the stage-1 static closure.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crash = require('./crashReport.js') as typeof import('./crashReport.js')
    // THIS persist's own landing — never the module latch's memory of an
    // earlier one: the path counts only when the write moved it.
    const before = crash.lastCrashReportPath()
    crash.persistCrashReport(err, undefined, 'boot')
    const after = crash.lastCrashReportPath()
    reportPath = after !== null && after !== before ? after : null
    if (reportPath === null) {
      const refusal = crash.lastCrashReportRefusal()
      reportRefusal = `${crash.crashReportDirDisplay()} refused the write${refusal !== null ? `: ${refusal}` : ''}`
    }
  } catch (forensicsErr) {
    // Forensics, never a dependency of the exit.
    reportRefusal = forensicsErr instanceof Error ? forensicsErr.message : String(forensicsErr)
  }
  runTerminalRestoration()
  const firstLine = (err.message.split('\n')[0] ?? '').trim() || err.name
  const cause = moduleFailure
    ? `${firstLine} — the running artifact does not carry a module it needs`
    : `${err.name}: ${firstLine}`
  const consequence =
    origin === 'boot'
      ? 'no session was opened and nothing was changed'
      : 'the session was stopped before it could act on a broken runtime'
  // The next-step speaks only about a report that LANDED (the Windows
  // field's TASK-018 wave 5, first-run-cold-box): the `report:` line was
  // already conditional on the write, but this sentence kept promising
  // "the report below carries it" on the one failure class that most
  // reliably kills the report — an unwritable config home — and pointed
  // at --debug, whose trace lands in that same home. A refused write names
  // itself and sends the trace to the console instead.
  const next = moduleFailure
    ? 'redeploy the runtime (scripts/ops/deploy-runtime.sh) or roll back (mercury update --rollback); `mercury health` names the runtime in use'
    : reportPath !== null
      ? 'run again with --debug for the full trace; the report below carries it'
      : `run again with --debug --debug-to-stderr for the full trace on this console — no crash report could be written (${reportRefusal})`
  const lines = [
    '',
    'MERCURY COULD NOT START',
    `cause:        ${cause}`,
    `consequence:  ${consequence}`,
    `next:         ${next}`,
    ...(reportPath ? [`report:       ${reportPath}`] : []),
    '',
  ]
  try {
    writeSync(2, `${lines.join('\n')}\n`)
  } catch {
    // The terminal may already be gone.
  }
  // The bounded crash tail (prove-crash-shutdown): what a live session had
  // in flight — nothing at a pure boot failure, where no seam has
  // registered yet — lands under the cap, then the process exits from
  // inside. Returning (not throwing) keeps the process-level handlers
  // healthy: a throw from an uncaughtException listener is a fatal double
  // fault that would kill the drain it just scheduled.
  void crashShutdown(1)
}

//
// The crash breaker (sliding window)
//

const BREAKER_WINDOW_MS = 5000
const BREAKER_THRESHOLD = 10
const BREAKER_RING_CAPACITY = 3

type CrashRecord = { name: string; message: string }

let persistedUncaughtOnce = false
let persistedRejectionOnce = false

const breaker = {
  windowStartMs: 0,
  count: 0,
  tripped: false,
  ring: [] as CrashRecord[],
}

/** Records an occurrence; true exactly when this occurrence tripped the breaker. */
export function recordUncaughtAndCheckBreaker(nowMs: number): boolean {
  if (breaker.tripped) return false
  if (nowMs - breaker.windowStartMs > BREAKER_WINDOW_MS) {
    breaker.windowStartMs = nowMs
    breaker.count = 0
    breaker.ring = []
  }
  breaker.count++
  if (breaker.count >= BREAKER_THRESHOLD) {
    breaker.tripped = true
    return true
  }
  return false
}

export function isUncaughtBreakerTripped(): boolean {
  return breaker.tripped
}

//
// Signal setup
//

function isPrintMode(): boolean {
  return process.argv.includes('-p') || process.argv.includes('--print')
}

function isDaemonSubcommand(): boolean {
  return process.argv[2] === 'daemon'
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

let handlersInstalled = false

export const setupGracefulShutdown = (): void => {
  // A plain latch (memoize would drag lodash-es into the stage-1 closure):
  // the later call inside init() coalesces with cli.tsx's step-9 call.
  if (handlersInstalled) return
  handlersInstalled = true

  // Hold the exit-hook library's subscriber count permanently above zero:
  // at zero it tears itself down and removes its process-level listener for
  // every signal (on the Bun runtime that also resets the kernel
  // disposition, so the signal terminates the process outright).
  onExit(() => {})

  // The daemon subcommand owns its own signals; its asynchronous teardown
  // must complete, and a competing handler that exits first leaves stale
  // durable state. Crash handlers stay armed for it.
  if (!isDaemonSubcommand()) {
    process.on('SIGINT', () => {
      // Print mode registers its own handler that aborts the in-flight query
      // and shuts down; racing it is wrong.
      if (isPrintMode()) return
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
      gracefulShutdownSync(0)
    })
    process.on('SIGTERM', () => {
      // Print mode registers its own handler that aborts the in-flight query
      // first, so the transcript records the interruption before shutdown —
      // racing it here would exit on an unsettled turn.
      if (isPrintMode()) return
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGTERM' })
      gracefulShutdownSync(143)
    })
    // SIGHUP is NOT posix-only: Node delivers it on a Windows console
    // close (CTRL_CLOSE_EVENT), and fencing it to non-win32 meant window
    // close ran no shutdown — the Bash lane's children outlived Mercury
    // (FC-024). Registered on every platform; the descriptor-revocation
    // orphan probe below stays POSIX-gated (macOS semantics).
    process.on('SIGHUP', () => {
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGHUP' })
      gracefulShutdownSync(129)
    })
    // Ctrl+Break: Windows delivers CTRL_BREAK_EVENT as SIGBREAK — the reflex
    // reach when a long turn looks hung and Ctrl+C seems ignored. With no
    // listener no JavaScript ran at all: the terminal stayed on the
    // alternate screen with raw mode armed, the cleanup registry and the
    // exit-cliff drains never ran, and the session vanished with no
    // shutdown record and no resume hint (FN-015 rank 21). Same bounded
    // shutdown as the console close; listenable on every platform,
    // delivered only on win32. 149 = 128 + SIGBREAK's number, 21.
    process.on('SIGBREAK', () => {
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGBREAK' })
      gracefulShutdownSync(149)
    })
    if (process.platform !== 'win32') {
      // macOS revokes terminal descriptors instead of signalling.
      if (process.stdin.isTTY) {
        const orphanCheck = setInterval(() => {
          // Cheap but not free: scroll frames need every event-loop turn.
          if (getIsScrollDraining()) return
          if (!process.stdout.writable || !process.stdin.readable) {
            clearInterval(orphanCheck)
            logForDiagnosticsNoPII('warn', 'orphan_detected', {
              stdoutWritable: Boolean(process.stdout.writable),
              stdinReadable: Boolean(process.stdin.readable),
            })
            gracefulShutdownSync(129)
          }
        }, ORPHAN_CHECK_INTERVAL_MS)
        orphanCheck.unref()
      }
    }
  }

  // The stdout/stderr counterparty can leave under a live session — the
  // terminal window closes, a PTY is torn down — and the stream's next
  // write raises an 'error' event (write EIO/EPIPE). Unhandled, that event
  // is an uncaughtException: a crash report, and a "previous session
  // crashed" notice at the next boot, for what was the terminal going away.
  // Armed here, beside the crash handler, so every boot gets the stream-gone
  // handlers from the one installer: a gone stream is destroyed (a write
  // after destroy raises no second 'error'), and the orphan probe above ends
  // the session honestly.
  registerProcessOutputErrorHandlers()

  process.on('uncaughtException', (err: unknown) => {
    // A module the artifact cannot load is a packaging defect, never a
    // recoverable fault: the loud exit, not a breaker tally.
    if (isModuleLoadFailure(err) && !isShuttingDown()) {
      failLoud(err, 'uncaught-exception')
      // The bounded crash tail is scheduled; nothing below may run under it.
      return
    }
    if (breaker.tripped) return
    const error = err instanceof Error ? err : undefined
    const name = error?.name ?? 'Error'
    const message = truncate(String(error?.message ?? err), 2000)
    logForDebugging(`uncaughtException: ${name}: ${message}`)
    logForDiagnosticsNoPII('error', 'uncaught_exception', { name })
    const tripped = recordUncaughtAndCheckBreaker(Date.now())
    if (breaker.ring.length < BREAKER_RING_CAPACITY || tripped) {
      breaker.ring.push({ name, message: truncate(message, 200) })
    }
    // THE FORENSICS GAP (crash-archive census): ordinary uncaught
    // exceptions in a live session survived by design but wrote ZERO
    // on-disk forensics — the archive held only module-load and React
    // boundary reports. The FIRST uncaught per process persists (a storm
    // never floods the capped archive), and a breaker trip persists the
    // fatal one below.
    if (!persistedUncaughtOnce) {
      persistedUncaughtOnce = true
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('./crashReport.js') as typeof import('./crashReport.js')
        crashMod.persistCrashReport(err, undefined, 'uncaught-exception')
      } catch {
        // Forensics, never a dependency of survival.
      }
    }
    if (tripped) {
      // Restore the terminal first so the dump lands on a sane terminal.
      runTerminalRestoration()
      try {
        for (const record of breaker.ring) {
          process.stderr.write(`${record.name}: ${record.message}\n`)
        }
        process.stderr.write(
          `Crash loop detected: ${breaker.count} uncaught exceptions within ${BREAKER_WINDOW_MS}ms; exiting.\n`,
        )
      } catch {
        // Ignored.
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('./crashReport.js') as typeof import('./crashReport.js')
        crashMod.persistCrashReport(err, undefined, 'uncaught-exception')
      } catch {
        // Forensics, never a dependency of the exit.
      }
      // The third crash entrance takes the bounded road too (FN-015 rank
      // 53): a bare forceExit here threw away the transcript appends still
      // queued for the turn in flight and printed no resume hint — the exit
      // that most needed a recovery route was the one that printed none.
      // The road's cap bounds how long a crash-looping process lingers; a
      // shutdown already in progress keeps its own failsafe and this arm
      // exits directly rather than wait on it.
      if (isShuttingDown()) forceExit(1)
      else void crashShutdown(1)
    }
  })

  process.on('unhandledRejection', (reason: unknown) => {
    // A module the artifact cannot load is a packaging defect, never a
    // recoverable background hiccup: the loud exit, not a log line (the
    // deployed-runtime hang). Every other rejection keeps the
    // log-only posture — a live session must survive a failing warm-up.
    if (isModuleLoadFailure(reason) && !isShuttingDown()) {
      failLoud(reason, 'unhandled-rejection')
      // The bounded crash tail is scheduled; nothing below may run under it.
      return
    }
    if (!persistedRejectionOnce && reason instanceof Error) {
      // Same forensics gap as the uncaught arm: the survive-by-design
      // posture stands (log-only, the session lives), but the FIRST
      // rejection per process leaves an on-disk report.
      persistedRejectionOnce = true
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('./crashReport.js') as typeof import('./crashReport.js')
        crashMod.persistCrashReport(reason, undefined, 'unhandled-rejection')
      } catch {
        // Forensics, never a dependency of survival.
      }
    }
    if (reason instanceof Error) {
      logForDebugging(
        `unhandledRejection: ${reason.name}: ${truncate(reason.message, 2000)}\n${truncate(reason.stack ?? '', 4000)}`,
      )
      logForDiagnosticsNoPII('error', 'unhandled_rejection', { kind: 'error', name: reason.name })
    } else if (typeof reason === 'string') {
      logForDebugging(`unhandledRejection: ${truncate(reason, 2000)}`)
      logForDiagnosticsNoPII('error', 'unhandled_rejection', { kind: 'string' })
    } else {
      logForDebugging('unhandledRejection: unknown reason')
      logForDiagnosticsNoPII('error', 'unhandled_rejection', { kind: 'unknown' })
    }
  })

  // Belt-and-braces for the synchronous exit paths: on interactive boots,
  // warm the restoration module once boot has settled so any later at-exit
  // require is a cache hit even under a wedged module loader. Unref'd — it
  // must never hold a short-lived process open; a pre-prefetch exit still
  // resolves synchronously at fire time.
  if (process.stdout.isTTY) {
    const prefetch = setTimeout(() => {
      void import('./shutdownRestoration.js')
        .then(mod => {
          restorationModule = mod
        })
        .catch(() => {})
    }, RESTORATION_PREFETCH_DELAY_MS)
    prefetch.unref()
  }
}

//
// Graceful shutdown
//

let shutdownInProgress = false

export function isShuttingDown(): boolean {
  return shutdownInProgress
}

export async function gracefulShutdown(
  exitCode: number = 0,
  reason: ExitReason = 'other',
  options?: GracefulShutdownOptions,
): Promise<void> {
  if (shutdownInProgress) return
  shutdownInProgress = true

  // Resolve the restoration half first (asynchronously — this path can):
  // everything below, the failsafe timer's callback included, then reads the
  // pre-resolved ref. Same load gate as the sync paths.
  if (!restorationModule && process.stdout.isTTY) {
    try {
      restorationModule = await import('./shutdownRestoration.js')
    } catch (err) {
      logForDebugging(`gracefulShutdown: restoration module import failed: ${String(err)}`)
    }
  }

  // The hook budget first, so the failsafe can be derived from it — a
  // user-raised budget must not be cut short by a shorter failsafe.
  const hooks = await import('./hooks.js')
  const hookBudgetMs = hooks.getSessionEndHookTimeoutMs()
  failsafeTimer = setTimeout(() => {
    runTerminalRestoration()
    runResumeHint()
    forceExit(exitCode)
  }, Math.max(FAILSAFE_FLOOR_MS, hookBudgetMs + FAILSAFE_HOOK_MARGIN_MS))
  failsafeTimer.unref()

  process.exitCode = exitCode

  // Before any asynchronous work: cleanup can take seconds and be cut off by
  // an unstoppable kill, and the user still gets the hint when that happens.
  runTerminalRestoration()
  runResumeHint()

  // Persisting the session is the one cleanup that must not be lost; hooks
  // and network work can block for a long time against a dead terminal.
  // The promise is HELD past the cap: a cleanup that overruns the race is
  // not abandoned to race process.exit — the quiescence wait at the exit
  // cliff below gives its in-flight I/O one bounded last chance to LAND
  // (TASK-017 D3: on win32 a libuv threadpool completion arriving inside
  // the exit teardown is async.c:94's abort — 0xC0000409, the box's 3/3
  // repro after a settled -p turn — so exiting with knowingly in-flight
  // work is a crash, not a quirk).
  const cleanupRun = runCleanupFunctions()
  let cleanupTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanupRun,
      new Promise<void>((_, reject) => {
        cleanupTimeout = setTimeout(() => reject(new Error('cleanup timed out')), CLEANUP_TIMEOUT_MS)
      }),
    ])
  } catch {
    // Cleanup errors and the timeout are both swallowed.
  } finally {
    if (cleanupTimeout) clearTimeout(cleanupTimeout)
  }

  try {
    await hooks.executeSessionEndHooks(reason, {
      getAppState: options?.getAppState,
      setAppState: options?.setAppState,
      signal: AbortSignal.timeout(hookBudgetMs),
      timeoutMs: hookBudgetMs,
    })
  } catch {
    // Every exception including the abort.
  }

  // Before anything cancels timers.
  try {
    profileReport()
  } catch {
    // Ignored.
  }

  if (options?.finalMessage !== undefined) {
    try {
      process.stderr.write(`${options.finalMessage}\n`)
    } catch {
      // The stream may be closed after a disconnect.
    }
  }

  // THE NAMED DRAIN (TASK-017 D3, the handle census): the seams the cleanup
  // registry cannot see — the transcript writer's appends queued AFTER its
  // cleanup flush (session-end hook progress, the final result record), the
  // session-room transcript mirror, every opened room's append chain and
  // watcher — land by name under one bounded grace (exitCliffDrain.ts).
  // After the hooks on purpose (they can still append); a fire-time import
  // so the drain owner never joins the stage-1 closure.
  try {
    const { drainExitCliffSeams } = await import('./exitCliffDrain.js')
    await drainExitCliffSeams()
  } catch (err) {
    logForDebugging(`gracefulShutdown: exit-cliff drain failed (ignored): ${String(err)}`)
  }

  // A piped stdout (stream-json hosts, pipelines) drains before the exit
  // that would otherwise drop what libuv still holds (sweep #2,
  // packet 76).
  await drainPipedStdoutForExit()

  // THE EXIT-CLIFF QUIESCENCE (TASK-017 D3): a cleanup that overran its cap
  // has already had the whole hooks + drain tail to settle; this is the
  // last bounded grace before process.exit tears the loop down under its
  // in-flight completions. Settled cleanup ⇒ zero cost.
  await quiesceCleanupBeforeExit(cleanupRun)

  forceExit(exitCode)
}

/** Bounded last grace at the exit cliff for a cleanup still in flight
 *  (TASK-017 D3, the 0xC0000409 family — the win32 libuv assert fires when
 *  a threadpool completion lands inside process.exit's teardown). A settled
 *  promise returns at once; a rejected one never throws here; a still-
 *  running one gets at most the grace, then the exit proceeds — this
 *  narrows the in-flight window, it cannot hold a wedged cleanup forever.
 *  Exported for the parity prover. */
/** The crash entrance's hard cap (operator-ruled): whatever the drains land
 *  in this window lands; the failsafe then exits regardless. */
export const CRASH_SHUTDOWN_BUDGET_MS = 1500
const CRASH_CLEANUP_CAP_MS = 700

/** The bounded crash-shutdown — the SAME durability road as gracefulShutdown
 *  (terminal restore · the cleanup registry · the named exit-cliff drains ·
 *  the piped-stdout drain · the resume hint) under one hard cap, with
 *  session-end hooks SKIPPED: a crashed run must not host hook code, and
 *  the crash card's "preserved" sentence is only true because this runs.
 *  All three crash entrances take it: the render-crash catch (main.tsx's
 *  waitUntilExit rejection), failLoud's tail, and the tripped crash-loop
 *  breaker. Never throws; the process exits from inside (the cap's failsafe
 *  guarantees it). */
export async function crashShutdown(exitCode: number): Promise<void> {
  if (shutdownInProgress) return
  shutdownInProgress = true

  if (!restorationModule && process.stdout.isTTY) {
    try {
      restorationModule = await import('./shutdownRestoration.js')
    } catch (err) {
      logForDebugging(`crashShutdown: restoration module import failed: ${String(err)}`)
    }
  }

  const cap = setTimeout(() => {
    runTerminalRestoration()
    runResumeHint()
    forceExit(exitCode)
  }, CRASH_SHUTDOWN_BUDGET_MS)
  cap.unref()

  process.exitCode = exitCode

  // Restore + hint FIRST: the drains below can be cut off by the cap, and
  // the operator still gets a sane terminal and the resume line.
  runTerminalRestoration()
  runResumeHint()

  const cleanupRun = runCleanupFunctions()
  let cleanupTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanupRun,
      new Promise<void>((_, reject) => {
        cleanupTimeout = setTimeout(() => reject(new Error('crash cleanup timed out')), CRASH_CLEANUP_CAP_MS)
      }),
    ])
  } catch {
    // Cleanup errors and the cap are both swallowed — the exit proceeds.
  } finally {
    if (cleanupTimeout) clearTimeout(cleanupTimeout)
  }

  try {
    const { drainExitCliffSeams } = await import('./exitCliffDrain.js')
    await drainExitCliffSeams()
  } catch (err) {
    logForDebugging(`crashShutdown: exit-cliff drain failed (ignored): ${String(err)}`)
  }

  await drainPipedStdoutForExit()
  await quiesceCleanupBeforeExit(cleanupRun)
  clearTimeout(cap)
  forceExit(exitCode)
}

export const EXIT_QUIESCENCE_MS = 400
export async function quiesceCleanupBeforeExit(
  cleanupRun: Promise<unknown>,
  graceMs: number = EXIT_QUIESCENCE_MS,
): Promise<void> {
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanupRun.catch(() => {}),
      new Promise<void>(resolveGrace => {
        grace = setTimeout(resolveGrace, graceMs)
      }),
    ])
  } finally {
    if (grace) clearTimeout(grace)
  }
}

/**
 * Drain a PIPED stdout before exit. Pipe writes are asynchronous on macOS
 * and Windows, and process.exit discards whatever libuv has not handed to
 * the kernel yet — a slow-reading consumer lost the tail of the stream
 * (the result envelope itself, on a busy pipeline). The wait is bounded by
 * PROGRESS, not a flat cap: while bytes keep leaving the buffer it keeps
 * waiting, however much is queued; a consumer that stops reading for
 * `stallMs` is abandoned with the remainder counted. A TTY never waits.
 */
export async function drainPipedStdoutForExit(
  stdout: { isTTY?: boolean; writableLength: number } = process.stdout,
  stallMs = 2_000,
): Promise<{ drained: boolean; remainingBytes: number }> {
  if (stdout.isTTY) return { drained: true, remainingBytes: 0 }
  let last = stdout.writableLength
  if (last === 0) return { drained: true, remainingBytes: 0 }
  const deadline = armInactivityDeadline({ seam: 'stdout drain at exit', limitMs: stallMs })
  try {
    while (stdout.writableLength > 0 && !deadline.fired) {
      await new Promise(resolve => setTimeout(resolve, 10))
      const now = stdout.writableLength
      if (now < last) {
        deadline.touch()
        last = now
      }
    }
  } finally {
    deadline.cancel()
  }
  const remainingBytes = stdout.writableLength
  if (remainingBytes > 0) {
    logForDebugging(`stdout drain at exit: consumer stalled for ${stallMs}ms with ${remainingBytes} bytes still queued`)
  }
  return { drained: remainingBytes === 0, remainingBytes }
}

/**
 * The synchronous entry: sets the exit code immediately (a caller can detect
 * a requested shutdown by inspecting it) and starts the asynchronous
 * shutdown.
 */
export function gracefulShutdownSync(
  exitCode: number = 0,
  reason: ExitReason = 'other',
  options?: GracefulShutdownOptions,
): void {
  process.exitCode = exitCode
  void gracefulShutdown(exitCode, reason, options).catch(err => {
    logError(err)
    try {
      runTerminalRestoration()
      runResumeHint()
      forceExit(exitCode)
    } catch {
      // The re-thrown forced exit under tests must never surface as an
      // unhandled rejection.
    }
  })
}
