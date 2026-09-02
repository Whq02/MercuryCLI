import { dirname, join } from 'node:path'

import { getSessionId } from '../bootstrap/state.js'
import { createBufferedWriter, type BufferedWriter } from './bufferedWriter.js'
import { CACHE_PATHS } from './cachePaths.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'
import { attachErrorLogSink, dateToFilename } from './log.js'

/**
 * The heavy error/MCP logging backend attached at startup to the
 * dependency-free logging facade (which queues events until attachment —
 * that is how import cycles are avoided).
 */

// Computed once at module load: a process running past midnight keeps
// writing to the file named for its start date. The stamp comes from the
// shared filename converter.
const LOG_FILE_NAME = `${dateToFilename(new Date())}.jsonl`

export function getErrorsPath(): string {
  return join(CACHE_PATHS.errors(), LOG_FILE_NAME)
}

export function getMCPLogsPath(serverName: string): string {
  return join(CACHE_PATHS.mcpLogs(serverName), LOG_FILE_NAME)
}

// Per-path buffered JSONL writers. Unlike the debug log these are NOT
// immediate-mode: they flush every second or at 50 buffered entries.
const logWriters = new Map<string, BufferedWriter>()

function getWriterFor(path: string): BufferedWriter {
  const existing = logWriters.get(path)
  if (existing) return existing
  const fs = getFsImplementation()
  const writer = createBufferedWriter({
    writeFn: content => {
      try {
        fs.appendFileSync(path, content)
      } catch {
        // Create the parent and retry once; the retry is deliberately NOT
        // guarded, so a second failure propagates out of the writer.
        fs.mkdirSync(dirname(path))
        fs.appendFileSync(path, content)
      }
    },
    flushIntervalMs: 1000,
    maxBufferSize: 50,
  })
  logWriters.set(path, writer)
  registerCleanup(async () => {
    writer.dispose()
  })
  return writer
}

function writeJsonlRecord(path: string, record: Record<string, unknown>): void {
  getWriterFor(path).write(`${JSON.stringify(record)}\n`)
}

function deriveErrorString(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

type HttpishError = {
  config?: { url?: unknown }
  response?: {
    status?: unknown
    data?: unknown
  }
}

/**
 * For an HTTP-client error carrying a request URL, a bracketed context
 * prefix of `key=value` parts joined with a BARE comma (url, status when
 * present, and `body=` carrying the server-supplied message extracted from
 * the response body) followed by a space.
 */
function buildHttpContextPrefix(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const candidate = error as HttpishError
  const url = candidate.config?.url
  if (typeof url !== 'string') return ''
  const parts: string[] = [`url=${url}`]
  const status = candidate.response?.status
  if (typeof status === 'number') parts.push(`status=${status}`)
  const body = candidate.response?.data
  let serverMessage: string | undefined
  if (typeof body === 'string') {
    serverMessage = body
  } else if (typeof body === 'object' && body !== null) {
    const record = body as { message?: unknown; error?: unknown }
    if (typeof record.message === 'string') {
      serverMessage = record.message
    } else if (
      typeof record.error === 'object' &&
      record.error !== null &&
      typeof (record.error as { message?: unknown }).message === 'string'
    ) {
      serverMessage = (record.error as { message: string }).message
    }
  }
  if (serverMessage !== undefined) parts.push(`body=${serverMessage}`)
  return `[${parts.join(',')}] `
}

/**
 * Dead arm, reproduced as built: the enriched-record append to the errors
 * JSONL returns unconditionally, so `logError` reaches only the debug log
 * and nothing is ever appended to the errors file. The path helper stays
 * exported because other code names the file.
 */
function appendToLog(logPath: string, record: Record<string, unknown>): void {
  return
}

function sinkLogError(error: unknown): void {
  const derived = deriveErrorString(error)
  const prefix = buildHttpContextPrefix(error)
  const name = error instanceof Error ? error.name : 'Error'
  logForDebugging(`${name}: ${prefix}${derived}`, { level: 'error' })
  appendToLog(getErrorsPath(), {
    timestamp: new Date().toISOString(),
    message: derived,
  })
}

function sinkLogMCPError(serverName: string, error: unknown): void {
  const errorString = deriveErrorString(error)
  // No colon after the closing quote on the error line; the category
  // extractor anchors on the quoted name only.
  logForDebugging(`MCP server "${serverName}" ${errorString}`, { level: 'error' })
  writeJsonlRecord(getMCPLogsPath(serverName), {
    error: errorString,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    // The PROCESS working directory as the filesystem facade reports it,
    // not the tracked directory.
    cwd: getFsImplementation().cwd(),
  })
}

function sinkLogMCPDebug(serverName: string, message: string): void {
  logForDebugging(`MCP server "${serverName}": ${message}`)
  writeJsonlRecord(getMCPLogsPath(serverName), {
    debug: message,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    cwd: getFsImplementation().cwd(),
  })
}

/**
 * Attach the three logging implementations plus the two path helpers to the
 * facade, then log one debug line. Runs before the analytics sink is
 * attached; the idempotency contract lives in the facade's attach function —
 * this performs the attach and the log on every call.
 */
export function initializeErrorLogSink(): void {
  attachErrorLogSink({
    logError: sinkLogError,
    logMCPError: sinkLogMCPError,
    logMCPDebug: sinkLogMCPDebug,
    getErrorsPath,
    getMCPLogsPath,
  })
  logForDebugging('error log sink attached')
}
