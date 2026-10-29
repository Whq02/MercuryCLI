import { dirname, join } from 'node:path'

import { getSessionId } from '../bootstrap/state.js'
import { createBufferedWriter, type BufferedWriter } from './bufferedWriter.js'
import { CACHE_PATHS } from './cachePaths.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getErrnoCode } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { attachErrorLogSink, dateToFilename } from './log.js'

const LOG_FILE_NAME = `${dateToFilename(new Date())}.jsonl`

function localDayFilename(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}.jsonl`
}

export function getErrorsPath(now: Date = new Date()): string {
  return join(CACHE_PATHS.errors(), localDayFilename(now))
}

function getMCPLogsPath(serverName: string): string {
  return join(CACHE_PATHS.mcpLogs(serverName), LOG_FILE_NAME)
}

const logWriters = new Map<string, BufferedWriter>()

const LOG_FILE_BYTE_CEILING = 8 * 1024 * 1024
const LOG_RECORD_MESSAGE_CEILING = 16 * 1024

const closedPaths = new Set<string>()

function closePath(path: string, why: string): void {
  if (closedPaths.has(path)) return
  closedPaths.add(path)
  logForDebugging(`log file ${path}: ${why}; its later entries are dropped`, { level: 'error' })
}

function fileSize(fs: ReturnType<typeof getFsImplementation>, path: string): number {
  try {
    return fs.statSync(path).size
  } catch {
    return 0
  }
}

function appendBounded(path: string, content: string): void {
  if (closedPaths.has(path)) return
  const fs = getFsImplementation()
  const lines = content.match(/[^\n]*\n/g) ?? [content]
  for (const line of lines) {
    if (closedPaths.has(path)) return
    const size = fileSize(fs, path)
    if (size + line.length > LOG_FILE_BYTE_CEILING) {
      closePath(path, `reached its ${LOG_FILE_BYTE_CEILING} byte ceiling`)
      return
    }
    try {
      fs.mkdirSync(dirname(path))
      fs.appendFileSync(path, line)
    } catch (error) {
      closePath(path, `cannot be written (${getErrnoCode(error) ?? deriveErrorString(error)})`)
      return
    }
  }
}

function getWriterFor(path: string): BufferedWriter {
  const existing = logWriters.get(path)
  if (existing) return existing
  const writer = createBufferedWriter({
    writeFn: content => appendBounded(path, content),
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

export function resetErrorLogSinkForTest(): void {
  for (const writer of logWriters.values()) writer.dispose()
  logWriters.clear()
  closedPaths.clear()
}

function boundedMessage(text: string): string {
  if (text.length <= LOG_RECORD_MESSAGE_CEILING) return text
  return `${text.slice(0, LOG_RECORD_MESSAGE_CEILING)} … (${text.length} characters, cut at ${LOG_RECORD_MESSAGE_CEILING})`
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

function sinkLogError(error: unknown): void {
  const derived = deriveErrorString(error)
  const prefix = buildHttpContextPrefix(error)
  const name = error instanceof Error ? error.name : 'Error'
  logForDebugging(`${name}: ${prefix}${derived}`, { level: 'error' })
  writeJsonlRecord(getErrorsPath(), {
    timestamp: new Date().toISOString(),
    message: boundedMessage(`${prefix}${derived}`),
    sessionId: getSessionId(),
  })
}

function sinkLogMCPError(serverName: string, error: unknown): void {
  const errorString = deriveErrorString(error)

  logForDebugging(`MCP server "${serverName}" ${errorString}`, { level: 'error' })
  writeJsonlRecord(getMCPLogsPath(serverName), {
    error: errorString,
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),

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
