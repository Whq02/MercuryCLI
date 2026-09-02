import { dirname, join } from 'node:path'

import { memoize } from 'lodash-es'

import { getSessionId } from '../bootstrap/state.js'
import { renameWithWin32Retry } from '../substrate/durablePublish.js'
import { createBufferedWriter, type BufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import { parseDebugFilter, shouldShowDebugMessage, type DebugFilter } from './debugFilter.js'
import { isENOENT } from './errors.js'
import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { writeToStderr } from './process.js'
import { jsonStringify } from './slowOperations.js'

/**
 * Debug-mode detection, level filtering, and the buffered/rotating debug
 * log writer.
 */

// Five levels in ascending severity. Verbose carries high-volume diagnostics
// (full command lines, shell, working directory, captured output) that would
// drown out useful output, so it is dropped unless explicitly requested.
export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: readonly DebugLogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error']

const MAX_DEBUG_LOG_BYTES = 10 * 1024 * 1024

/** Fixed minimum level (`debug`): no env override exists. */
export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  return 'debug'
})

// Runtime toggle flipped by a slash command so a session can start capturing
// without restarting.
let runtimeToggleEnabled = false

/** Memoized debug-mode predicate; exposes a cache-clearing handle. */
export const isDebugMode = memoize((): boolean => {
  if (runtimeToggleEnabled) return true
  if (isEnvTruthy(process.env.DEBUG)) return true
  if (isEnvTruthy(process.env.DEBUG_SDK)) return true
  if (process.argv.includes('--debug') || process.argv.includes('-d')) return true
  if (isDebugToStdErr()) return true
  if (process.argv.some(arg => arg.startsWith('--debug='))) return true
  if (getDebugFilePath() !== null) return true
  return false
})

/**
 * Flip the runtime toggle, clear the memo, and return whether logging was
 * ALREADY active.
 */
export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode()
  runtimeToggleEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

/** The argv-derived category filter (first `--debug=<pattern>` suffix). */
export const getDebugFilter = memoize((): DebugFilter | null => {
  const arg = process.argv.find(candidate => candidate.startsWith('--debug='))
  if (!arg) return null
  return parseDebugFilter(arg.slice('--debug='.length))
})

/** Log-to-stderr mode, from either documented CLI spelling. */
export const isDebugToStdErr = memoize((): boolean => {
  return process.argv.includes('--debug-to-stderr') || process.argv.includes('--d2e') || process.argv.includes('-d2e')
})

/** An explicit debug-file path from `--debug-file=<path>` or `--debug-file <path>`. */
export const getDebugFilePath = memoize((): string | null => {
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg.startsWith('--debug-file=')) {
      return arg.slice('--debug-file='.length)
    }
    if (arg === '--debug-file' && i + 1 < argv.length) {
      return argv[i + 1] as string
    }
  }
  return null
})

let hasFormattedOutput = false

export function setHasFormattedOutput(v: boolean): void {
  hasFormattedOutput = v
}

export function getHasFormattedOutput(): boolean {
  return hasFormattedOutput
}

/**
 * The log path: an explicit debug-file wins; else a per-session file inside
 * the logs-directory env var; else `debug/` under the config home. The
 * directory form joins the per-session file so each session keeps its own
 * log and directory-derived operations (mkdir, rotation, the `latest`
 * symlink) target the directory rather than its parent.
 */
export function getDebugLogPath(): string {
  const explicit = getDebugFilePath()
  if (explicit) return explicit
  const fileName = `${getSessionId()}.txt`
  return join(getMercuryHome(), 'debug', fileName)
}

// ---------------------------------------------------------------------------
// Rotation and symlink maintenance
// ---------------------------------------------------------------------------

let trackedLogSize: number | null = null
let rotationInProgress = false
let latestSymlinkRefreshed = false
// The single pending promise the flush/dispose paths await. The immediate
// write path is synchronous; only rotation work rides here.
let pendingMaintenance: Promise<void> = Promise.resolve()

/**
 * Track the active log's size (seeded from a stat on first call, then
 * incremented by bytes written) and rotate it past the maximum: rename to a
 * `.1`-infixed sibling (before a `.txt` extension when there is one) with
 * the bounded Windows-retry rename; on a non-ENOENT failure delete any
 * stale rotated file and retry once; failing that, delete the active log.
 * Every failure is swallowed — logging keeps working, just unrotated.
 */
export async function maybeRotateDebugLog(
  path: string,
  addedBytes: number,
  maxBytes: number = MAX_DEBUG_LOG_BYTES,
): Promise<void> {
  const fs = getFsImplementation()
  if (trackedLogSize === null) {
    try {
      trackedLogSize = fs.statSync(path).size
    } catch {
      trackedLogSize = 0
    }
  } else {
    trackedLogSize += addedBytes
  }
  if (trackedLogSize <= maxBytes || rotationInProgress) return
  rotationInProgress = true
  try {
    const rotatedPath = path.endsWith('.txt')
      ? `${path.slice(0, -'.txt'.length)}.1.txt`
      : `${path}.1`
    try {
      await renameWithWin32Retry(path, rotatedPath)
    } catch (err) {
      if (!isENOENT(err)) {
        try {
          await fs.unlink(rotatedPath)
        } catch {
          // Nothing stale to clear.
        }
        try {
          await renameWithWin32Retry(path, rotatedPath)
        } catch {
          try {
            await fs.unlink(path)
          } catch {
            // Give up; keep logging unrotated.
          }
        }
      }
    }
    trackedLogSize = 0
  } finally {
    rotationInProgress = false
  }
}

function refreshLatestSymlink(logPath: string, logDir: string): void {
  if (latestSymlinkRefreshed) return
  latestSymlinkRefreshed = true
  const fs = getFsImplementation()
  try {
    fs.unlinkSync(join(logDir, 'latest'))
  } catch {
    // No existing entry.
  }
  try {
    fs.symlinkSync(logPath, join(logDir, 'latest'))
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

let debugWriter: BufferedWriter | null = null
let currentLogDirectory: string | null = null

/**
 * The immediate write path MUST stay synchronous: an asynchronous write in
 * flight when the process is torn down directly never lands, and pending
 * asynchronous work re-arms the before-exit hook (which wedged the runtime
 * under a tracing build). The directory is created synchronously the first
 * time it changes — recursive, existing-directory-tolerant, throw-ignored —
 * then the append runs synchronously, and rotation plus symlink maintenance
 * fire without awaiting.
 */
function writeLogLine(content: string): void {
  // Re-test debug mode on every write.
  if (!isDebugMode()) return
  const logPath = getDebugLogPath()
  const logDir = dirname(logPath)
  const fs = getFsImplementation()
  if (currentLogDirectory !== logDir) {
    try {
      fs.mkdirSync(logDir)
    } catch {
      // Ignored; the append below will surface a truly unwritable directory.
    }
    currentLogDirectory = logDir
  }
  try {
    fs.appendFileSync(logPath, content)
  } catch {
    return
  }
  pendingMaintenance = maybeRotateDebugLog(logPath, content.length).then(() => {
    refreshLatestSymlink(logPath, logDir)
  })
}

function getWriter(): BufferedWriter {
  if (debugWriter) return debugWriter
  // Constructed lazily on the first message that survives gating — which
  // requires debug mode on — so the writer is always immediate-mode on any
  // live path (the buffered branch is dormant machinery; see the spec).
  debugWriter = createBufferedWriter({
    writeFn: writeLogLine,
    flushIntervalMs: 1000,
    maxBufferSize: 100,
    immediateMode: isDebugMode(),
  })
  registerCleanup(async () => {
    debugWriter?.dispose()
    await pendingMaintenance
  })
  return debugWriter
}

/** Force a flush and await the pending maintenance chain. */
export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingMaintenance
}

/**
 * Write a debug line. Gating, in order: level below the minimum; test
 * environment with stderr mode off; debug mode off; no Node-like runtime;
 * then the category filter.
 */
export function logForDebugging(message: string, opts?: { level: DebugLogLevel }): void {
  const level = opts?.level ?? 'debug'
  if (LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(getMinDebugLogLevel())) return
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) return
  if (!isDebugMode()) return
  if (typeof process === 'undefined' || !process.versions) return
  if (!shouldShowDebugMessage(message, getDebugFilter())) return

  let text = message
  if (hasFormattedOutput && text.includes('\n')) {
    // A multi-line message must not break the line-oriented consumer; the
    // encoding goes through the instrumented stringify.
    text = jsonStringify(text)
  }
  // The bare ISO timestamp leads the line (no brackets around it), then
  // the bracketed upper-cased level.
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${text.trim()}\n`
  if (isDebugToStdErr()) {
    writeToStderr(line)
    return
  }
  getWriter().write(line)
}

/**
 * Dead arm: intended to log first-party-only errors; inert in this build.
 * Kept as an exported no-op — do not reconstruct the logging it names.
 */
export function logAntError(context: string, error: unknown): void {
  return
}
