import { writeSync } from 'node:fs'
import { isSessionRunArgv as isRunArgv } from './sessionArgs.js'

import { onExit } from 'signal-exit'

import { getIsScrollDraining } from '../bootstrap/state.js'
import type { SESSION_END_REASONS } from './hooks/contract.js'

import { runCleanupFunctions } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { logError } from './log.js'
import { isPeerGoneWriteError, registerProcessInputErrorHandler, registerProcessOutputErrorHandlers } from './process.js'
import { profileReport } from './startupProfiler.js'
import { pollUntil, withDeadline } from './deadline.js'
import { passedOver } from './passedOver.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from './timers.js'
import { notBuilt } from '../pi/holes.js'


export type GracefulShutdownOptions = {
  finalMessage?: string
}

const CLEANUP_TIMEOUT_MS = 2000
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]
const SESSION_END_HOOK_BUDGET_MS = 1_500

const FAILSAFE_FLOOR_MS = 5000
const FAILSAFE_HOOK_MARGIN_MS = 3500
const ORPHAN_CHECK_INTERVAL_MS = 30_000
const RESTORATION_PREFETCH_DELAY_MS = 3000


type ShutdownRestorationModule = typeof import('./shutdownRestoration.js')

let restorationModule: ShutdownRestorationModule | undefined

let terminalGoneFlag = false
export function markTerminalGone(): void {
  terminalGoneFlag = true
}
function terminalIsGone(): boolean {
  return terminalGoneFlag || process.stdout.writable === false
}

export const TERMINAL_GONE_EXIT_CODE = 129

export function terminalGoneReadLine(code: string): string {
  return `terminal gone: stdin read ${code} — the session closes like a hangup (exit ${TERMINAL_GONE_EXIT_CODE})`
}

export function editorHandoverStdinFaultLine(code: string, syscall: string): string {
  return `stdin ${syscall} ${code} while the terminal was lent to an editor — the terminal is still here, so the session stays and input is re-armed (never a hangup)`
}

function resolveRestorationSync(): ShutdownRestorationModule | undefined {
  if (!restorationModule) {
    try {
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
  return notBuilt('src/utils/gracefulShutdown.ts:72')
}

function runResumeHint(): void {
  return notBuilt('src/utils/gracefulShutdown.ts:93')
}

function forceExit(exitCode: number): void {
  return notBuilt('src/utils/gracefulShutdown.ts:103')
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
  const { isMissingCwd, MISSING_CWD_LINE } = require('./runtime/nodePolicy.js') as typeof import('./runtime/nodePolicy.js')
  if (isMissingCwd(err)) {
    logForDiagnosticsNoPII('error', 'boot_cwd_missing', { origin })
    try {
      writeSync(2, `${MISSING_CWD_LINE}\n`)
    } catch (error) { passedOver(error) }
    void crashShutdown(1)
    return
  }
  let reportPath: string | null = null
  let reportRefusal = 'the config home refused the write'
  try {
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
      : `run again with --debug --log-stderr for the full trace on this console — no crash report could be written (${reportRefusal})`
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
  } catch (error) {
    passedOver(error)
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


function isRunMode(): boolean {
  return isRunArgv()
}

let runModeSignalsOwned = false
let preflightSignalWriter: ((code: number) => void) | undefined

export function setRunPreflightSignalWriter(writer: (code: number) => void): void {
  preflightSignalWriter = writer
}

function writePreflightSignal(code: number): void {
  const writer = preflightSignalWriter
  preflightSignalWriter = undefined
  try {
    writer?.(code)
  } catch (err) {
    if (!isPeerGoneWriteError(err)) logForDebugging(`gracefulShutdown: the run's interrupt outcome could not be written, its consumer has only the exit code: ${String(err)}`)
  }
}

export function markRunModeSignalsOwned(): void {
  runModeSignalsOwned = true
  preflightSignalWriter = undefined
}

function runModeOwnsSignals(): boolean {
  return isRunMode() && runModeSignalsOwned
}

function isDaemonSubcommand(): boolean {
  return process.argv[2] === 'daemon'
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

let handlersInstalled = false

export const setupGracefulShutdown = (): void => notBuilt('src/utils/gracefulShutdown.ts:281')


let shutdownInProgress = false

export function isShuttingDown(): boolean {
  return shutdownInProgress
}

function leaveWatchesToProcessEnd(): void {
  try {
    const watches = require('./watchRoot.js') as typeof import('./watchRoot.js')
    watches.leaveFileWatchesToProcessEnd()
  } catch (err) {
    logForDebugging(`gracefulShutdown: the file watches were not left to the process end: ${String(err)}`)
  }
}

export async function gracefulShutdown(
  exitCode?: number,
  reason?: SessionEndReason,
  options?: GracefulShutdownOptions,
): Promise<void> {
  return notBuilt('src/utils/gracefulShutdown.ts:457')
}

export const CRASH_SHUTDOWN_BUDGET_MS = 1500
const CRASH_CLEANUP_CAP_MS = 700

export async function crashShutdown(exitCode: number): Promise<void> {
  return notBuilt('src/utils/gracefulShutdown.ts:563')
}

export const EXIT_QUIESCENCE_MS = 400
export async function quiesceCleanupBeforeExit(
  cleanupRun: Promise<unknown>,
  graceMs: number = EXIT_QUIESCENCE_MS,
): Promise<void> {
  await withDeadline(cleanupRun.catch(passedOver), graceMs, () => undefined)
}

type PressureObserved = { writableLength: number; write(...args: unknown[]): boolean; on(event: 'drain' | 'error', listener: (...args: unknown[]) => void): unknown }
type PressureState = { pending: boolean; readerGone: boolean; waiters: Set<() => void> }
const stdoutPressure = new WeakMap<object, PressureState>()

function wakePressureWaiters(pressure: PressureState): void {
  const waiters = [...pressure.waiters]
  pressure.waiters.clear()
  for (const wake of waiters) wake()
}

export function observeStdoutPressure(stdout: PressureObserved = process.stdout): void {
  if (stdoutPressure.has(stdout)) return
  const pressure: PressureState = { pending: false, readerGone: false, waiters: new Set() }
  stdoutPressure.set(stdout, pressure)
  const write = stdout.write
  stdout.write = function (this: PressureObserved, ...args: unknown[]): boolean {
    const accepted = write.apply(this, args)
    if (!accepted && stdout.writableLength === 0) pressure.pending = true
    return accepted
  }
  stdout.on('drain', () => {
    pressure.pending = false
    wakePressureWaiters(pressure)
  })
  stdout.on('error', error => {
    if (isPeerGoneWriteError(error)) {
      pressure.readerGone = true
      wakePressureWaiters(pressure)
    }
  })
}

type DrainableStdout = {
  isTTY?: boolean
  writableLength: number
  destroyed?: boolean
  writable?: boolean
  on?(event: 'drain' | 'close' | 'error' | 'finish', listener: (...args: unknown[]) => void): unknown
  off?(event: 'drain' | 'close' | 'error' | 'finish', listener: (...args: unknown[]) => void): unknown
  removeListener?(event: 'drain' | 'close' | 'error' | 'finish', listener: (...args: unknown[]) => void): unknown
}

const STDOUT_DRAIN_POLL_MS = 10

function waitForStdoutEvent(
  stdout: DrainableStdout,
  pressure: PressureState | undefined,
  pollMs: number,
): Promise<void> {
  const remove = stdout.off?.bind(stdout) ?? stdout.removeListener?.bind(stdout)
  const canListen = typeof stdout.on === 'function' && remove !== undefined
  if (!canListen && pressure === undefined) return Promise.resolve()
  let cleanup = (): void => {}
  const eventWake = new Promise<void>(resolve => {
    let settled = false
    const wake = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const events = ['drain', 'close', 'error', 'finish'] as const
    cleanup = (): void => {
      pressure?.waiters.delete(wake)
      if (canListen) {
        for (const event of events) remove(event, wake)
      }
    }
    pressure?.waiters.add(wake)
    if (canListen) {
      for (const event of events) stdout.on!(event, wake)
    }
  })
  return withDeadline(eventWake, pollMs, () => {
    cleanup()
  })
}

export async function drainPipedStdoutForExit(
  stdout: DrainableStdout = process.stdout,
  pollMs: number = STDOUT_DRAIN_POLL_MS,
): Promise<{ drained: boolean; remainingBytes: number }> {
  if (stdout.isTTY) return { drained: true, remainingBytes: 0 }
  const pressure = stdoutPressure.get(stdout)
  const readerGone = (): boolean => pressure?.readerGone === true
  const readerAlive = (): boolean => !readerGone() && stdout.destroyed !== true && stdout.writable !== false
  const pressured = (): boolean => pressure?.pending === true
  const waiting = (): boolean => (stdout.writableLength > 0 || pressured()) && readerAlive()
  const canWaitEvent = pressure !== undefined || (typeof stdout.on === 'function' && (typeof stdout.off === 'function' || typeof stdout.removeListener === 'function'))
  if (waiting()) {
    if (canWaitEvent) {
      while (waiting()) {
        await waitForStdoutEvent(stdout, pressure, pollMs)
      }
    } else {
      await pollUntil(() => (waiting() ? undefined : true), pollMs, Infinity, () => true)
    }
  }
  const remainingBytes = stdout.writableLength
  const drained = remainingBytes === 0 && !pressured() && !readerGone()
  if (!drained) {
    logForDebugging(`stdout drain at exit: the reader's pipe is gone with ${remainingBytes > 0 ? `${remainingBytes} bytes` : 'bytes'} still queued`)
  }
  return { drained, remainingBytes }
}

export function gracefulShutdownSync(
  exitCode: number = 0,
  reason: SessionEndReason = 'closed',
  options?: GracefulShutdownOptions,
): void {
  process.exitCode = exitCode
  void gracefulShutdown(exitCode, reason, options).catch(err => {
    logError(err)
    try {
      runTerminalRestoration()
      runResumeHint()
    } catch (error) {
      passedOver(error)
    } finally {
      forceExit(exitCode)
    }
  })
}
