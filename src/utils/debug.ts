import { dirname, join } from 'node:path'

import { memoize } from 'lodash-es'

import { getSessionId } from '../bootstrap/state.js'
import { readSessionOption } from './sessionArgs.js'
import { renameWithWin32Retry } from '../substrate/durablePublish.js'
import { createBufferedWriter, type BufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import { parseDebugFilter, shouldShowDebugMessage, type DebugFilter } from './debugFilter.js'
import { isENOENT } from './errors.js'
import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { writeToStderr } from './process.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: readonly DebugLogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error']

const MAX_DEBUG_LOG_BYTES = 10 * 1024 * 1024

const getMinDebugLogLevel = memoize((): DebugLogLevel => {
  return 'debug'
})

let runtimeToggleEnabled = false

export const isDebugMode: Unbuilt = unbuilt('src/utils/debug.ts:31')

export function enableDebugLogging(): boolean {
  return notBuilt('src/utils/debug.ts:41')
}

const getDebugFilter = memoize((): DebugFilter | null => {
  const arg = process.argv.find(candidate => candidate.startsWith('--debug='))
  if (!arg) return null
  return parseDebugFilter(arg.slice('--debug='.length))
})

export const isDebugToStdErr = memoize((): boolean => {
  return readSessionOption(process.argv.slice(2), '--log-stderr').present
})

const getDebugFilePath = memoize((): string | null => {
  return readSessionOption(process.argv.slice(2), '--log-file').value ?? null
})

export function getDebugLogPath(): string {
  const explicit = getDebugFilePath()
  if (explicit) return explicit
  const fileName = `${getSessionId()}.txt`
  return join(getMercuryHome(), 'debug', fileName)
}


let trackedLogSize: number | null = null
let trackedLogPath: string | null = null
let rotationInProgress = false
let latestSymlinkRefreshed = false
let pendingMaintenance: Promise<void> = Promise.resolve()

async function maybeRotateDebugLog(
  path: string,
  addedBytes: number,
  maxBytes: number = MAX_DEBUG_LOG_BYTES,
): Promise<void> {
  const fs = getFsImplementation()
  if (trackedLogSize === null || trackedLogPath !== path) {
    trackedLogPath = path
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
        } catch (error) {
          passedOver(error)
        }
        try {
          await renameWithWin32Retry(path, rotatedPath)
        } catch {
          try {
            await fs.unlink(path)
          } catch (error) {
            passedOver(error)
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
  } catch (error) {
    passedOver(error)
  }
  try {
    fs.symlinkSync(logPath, join(logDir, 'latest'))
  } catch (error) {
    passedOver(error)
  }
}

function getWriter(): BufferedWriter {
  return notBuilt('src/utils/debug.ts:169')
}

export async function flushDebugLogs(): Promise<void> {
  return notBuilt('src/utils/debug.ts:184')
}

export function logForDebugging(message: string, opts?: { level: DebugLogLevel }): void {
  const level = opts?.level ?? 'debug'
  if (LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(getMinDebugLogLevel())) return
  if (process.env.NODE_ENV === 'test' && !isDebugToStdErr()) return
  if (!isDebugMode()) return
  if (typeof process === 'undefined' || !process.versions) return
  if (!shouldShowDebugMessage(message, getDebugFilter())) return

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message.trim()}\n`
  if (isDebugToStdErr()) {
    writeToStderr(line)
    return
  }
  getWriter().write(line)
}
