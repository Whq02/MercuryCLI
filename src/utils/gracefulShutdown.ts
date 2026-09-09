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


export type GracefulShutdownOptions = {
  getAppState?: () => AppState
  setAppState?: (updater: (prev: AppState) => AppState) => void
  finalMessage?: string
}

const CLEANUP_TIMEOUT_MS = 2000
const FAILSAFE_FLOOR_MS = 5000
const FAILSAFE_HOOK_MARGIN_MS = 3500
const ORPHAN_CHECK_INTERVAL_MS = 30_000
const RESTORATION_PREFETCH_DELAY_MS = 3000


type ShutdownRestorationModule = typeof import('./shutdownRestoration.js')

let restorationModule: ShutdownRestorationModule | undefined

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

const FALLBACK_CLOSE_SYNC_UPDATE = '\x1b[?2026l'
const FALLBACK_EXIT_ALT_SCREEN = '\x1b[?1049l'
const FALLBACK_SHOW_CURSOR = '\x1b[?25h'

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
  }
}

function runResumeHint(): void {
  const restoration =
    restorationModule ?? (process.stdout.isTTY ? resolveRestorationSync() : undefined)
  restoration?.printResumeHint()
}


let failsafeTimer: ReturnType<typeof setTimeout> | undefined

function forceExit(exitCode: number): void {
  if (failsafeTimer) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  try {
    const restoration =
      restorationModule ?? (process.stdout.isTTY ? resolveRestorationSync() : undefined)
    restoration?.drainStdinForExit()
  } catch {
  }
  try {
    process.exit(exitCode)
  } catch (err) {
    if (process.env.NODE_ENV === 'test') throw err
    process.kill(process.pid, 'SIGKILL')
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('forceExit: process.exit returned control')
  }
}


const MODULE_LOAD_CODES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_REQUIRE_ESM',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_INVALID_PACKAGE_CONFIG',
  'ERR_DLOPEN_FAILED',
])

export function isModuleLoadFailure(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false
  const code = (reason as { code?: unknown }).code
  if (typeof code === 'string' && MODULE_LOAD_CODES.has(code)) return true
  return /^Cannot find (?:module|package) /.test(reason.message)
}

export type LoudFailureOrigin = 'boot' | 'unhandled-rejection' | 'uncaught-exception'

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crash = require('./crashReport.js') as typeof import('./crashReport.js')
    const before = crash.lastCrashReportPath()
    crash.persistCrashReport(err, undefined, 'boot')
    const after = crash.lastCrashReportPath()
    reportPath = after !== null && after !== before ? after : null
    if (reportPath === null) {
      const refusal = crash.lastCrashReportRefusal()
      reportRefusal = `${crash.crashReportDirDisplay()} refused the write${refusal !== null ? `: ${refusal}` : ''}`
    }
  } catch (forensicsErr) {
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
  }
  void crashShutdown(1)
}


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


function isPrintMode(): boolean {
  return process.argv.includes('-p') || process.argv.includes('--print')
}

let printModeSignalsOwned = false

export function markPrintModeSignalsOwned(): void {
  printModeSignalsOwned = true
}

function printModeOwnsSignals(): boolean {
  return isPrintMode() && printModeSignalsOwned
}

function isDaemonSubcommand(): boolean {
  return process.argv[2] === 'daemon'
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

let handlersInstalled = false

export const setupGracefulShutdown = (): void => {
  if (handlersInstalled) return
  handlersInstalled = true

  onExit(() => {})

  if (!isDaemonSubcommand()) {
    process.on('SIGINT', () => {
      if (printModeOwnsSignals()) return
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
      gracefulShutdownSync(130)
    })
    process.on('SIGTERM', () => {
      if (printModeOwnsSignals()) return
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGTERM' })
      gracefulShutdownSync(143)
    })
    process.on('SIGHUP', () => {
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGHUP' })
      gracefulShutdownSync(129)
    })
    process.on('SIGBREAK', () => {
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGBREAK' })
      gracefulShutdownSync(149)
    })
    if (process.platform !== 'win32') {
      if (process.stdin.isTTY) {
        const orphanCheck = setInterval(() => {
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

  registerProcessOutputErrorHandlers()

  process.on('uncaughtException', (err: unknown) => {
    if (isModuleLoadFailure(err) && !isShuttingDown()) {
      failLoud(err, 'uncaught-exception')
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
    if (!persistedUncaughtOnce) {
      persistedUncaughtOnce = true
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('./crashReport.js') as typeof import('./crashReport.js')
        crashMod.persistCrashReport(err, undefined, 'uncaught-exception')
      } catch {
      }
    }
    if (tripped) {
      runTerminalRestoration()
      try {
        for (const record of breaker.ring) {
          process.stderr.write(`${record.name}: ${record.message}\n`)
        }
        process.stderr.write(
          `Crash loop detected: ${breaker.count} uncaught exceptions within ${BREAKER_WINDOW_MS}ms; exiting.\n`,
        )
      } catch {
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('./crashReport.js') as typeof import('./crashReport.js')
        crashMod.persistCrashReport(err, undefined, 'uncaught-exception')
      } catch {
      }
      if (isShuttingDown()) forceExit(1)
      else void crashShutdown(1)
    }
  })

  process.on('unhandledRejection', (reason: unknown) => {
    if (isModuleLoadFailure(reason) && !isShuttingDown()) {
      failLoud(reason, 'unhandled-rejection')
      return
    }
    if (!persistedRejectionOnce && reason instanceof Error) {
      persistedRejectionOnce = true
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crashMod = require('./crashReport.js') as typeof import('./crashReport.js')
        crashMod.persistCrashReport(reason, undefined, 'unhandled-rejection')
      } catch {
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

  if (!restorationModule && process.stdout.isTTY) {
    try {
      restorationModule = await import('./shutdownRestoration.js')
    } catch (err) {
      logForDebugging(`gracefulShutdown: restoration module import failed: ${String(err)}`)
    }
  }

  const hooks = await import('./hooks.js')
  const hookBudgetMs = hooks.getSessionEndHookTimeoutMs()
  failsafeTimer = setTimeout(() => {
    runTerminalRestoration()
    runResumeHint()
    forceExit(exitCode)
  }, Math.max(FAILSAFE_FLOOR_MS, hookBudgetMs + FAILSAFE_HOOK_MARGIN_MS))
  failsafeTimer.unref()

  process.exitCode = exitCode

  runTerminalRestoration()
  runResumeHint()

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
  }

  try {
    profileReport()
  } catch {
  }

  if (options?.finalMessage !== undefined) {
    try {
      process.stderr.write(`${options.finalMessage}\n`)
    } catch {
    }
  }

  try {
    const { drainExitCliffSeams } = await import('./exitCliffDrain.js')
    await drainExitCliffSeams()
  } catch (err) {
    logForDebugging(`gracefulShutdown: exit-cliff drain failed (ignored): ${String(err)}`)
  }

  await drainPipedStdoutForExit()

  await quiesceCleanupBeforeExit(cleanupRun)

  forceExit(exitCode)
}

export const CRASH_SHUTDOWN_BUDGET_MS = 1500
const CRASH_CLEANUP_CAP_MS = 700

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
    }
  })
}
