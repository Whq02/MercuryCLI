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


export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: readonly DebugLogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error']

const MAX_DEBUG_LOG_BYTES = 10 * 1024 * 1024

export const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  return 'debug'
})

let runtimeToggleEnabled = false

export const isDebugMode = memoize((): boolean => {
  if (runtimeToggleEnabled) return true
  if (isEnvTruthy(process.env.DEBUG)) return true
  if (process.argv.includes('--debug') || process.argv.includes('-d')) return true
  if (isDebugToStdErr()) return true
  if (process.argv.some(arg => arg.startsWith('--debug='))) return true
  if (getDebugFilePath() !== null) return true
  return false
})

export function enableDebugLogging(): boolean {
  const wasActive = isDebugMode()
  runtimeToggleEnabled = true
  isDebugMode.cache.clear?.()
  return wasActive
}

export const getDebugFilter = memoize((): DebugFilter | null => {
  const arg = process.argv.find(candidate => candidate.startsWith('--debug='))
  if (!arg) return null
  return parseDebugFilter(arg.slice('--debug='.length))
})

export const isDebugToStdErr = memoize((): boolean => {
  return process.argv.includes('--debug-to-stderr') || process.argv.includes('--d2e') || process.argv.includes('-d2e')
})

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

export function getDebugLogPath(): string {
  const explicit = getDebugFilePath()
  if (explicit) return explicit
  const fileName = `${getSessionId()}.txt`
  return join(getMercuryHome(), 'debug', fileName)
}


let trackedLogSize: number | null = null
let rotationInProgress = false
let latestSymlinkRefreshed = false
let pendingMaintenance: Promise<void> = Promise.resolve()

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
        }
        try {
          await renameWithWin32Retry(path, rotatedPath)
        } catch {
          try {
            await fs.unlink(path)
          } catch {
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
  }
  try {
    fs.symlinkSync(logPath, join(logDir, 'latest'))
  } catch {
  }
}


let debugWriter: BufferedWriter | null = null
let currentLogDirectory: string | null = null

function writeLogLine(content: string): void {
  if (!isDebugMode()) return
  const logPath = getDebugLogPath()
  const logDir = dirname(logPath)
  const fs = getFsImplementation()
  if (currentLogDirectory !== logDir) {
    try {
      fs.mkdirSync(logDir)
    } catch {
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

export async function flushDebugLogs(): Promise<void> {
  debugWriter?.flush()
  await pendingMaintenance
}

export function logForDebugging(message: string, opts?: { level: DebugLogLevel }): void {
  const level = opts?.level ?? 'debug'
  if (LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(getMinDebugLogLevel())) return
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) return
  if (!isDebugMode()) return
  if (typeof process === 'undefined' || !process.versions) return
  if (!shouldShowDebugMessage(message, getDebugFilter())) return

  let text = message
  if (hasFormattedOutput && text.includes('\n')) {
    text = jsonStringify(text)
  }
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${text.trim()}\n`
  if (isDebugToStdErr()) {
    writeToStderr(line)
    return
  }
  getWriter().write(line)
}

export function logAntError(context: string, error: unknown): void {
  return
}
