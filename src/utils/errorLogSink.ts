import { dirname, join } from 'node:path'

import { getSessionId } from '../bootstrap/state.js'
import { createBufferedWriter, type BufferedWriter } from './bufferedWriter.js'
import { CACHE_PATHS } from './cachePaths.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'
import { attachErrorLogSink, dateToFilename } from './log.js'


const LOG_FILE_NAME = `${dateToFilename(new Date())}.jsonl`

export function getErrorsPath(): string {
  return join(CACHE_PATHS.errors(), LOG_FILE_NAME)
}

export function getMCPLogsPath(serverName: string): string {
  return join(CACHE_PATHS.mcpLogs(serverName), LOG_FILE_NAME)
}

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
