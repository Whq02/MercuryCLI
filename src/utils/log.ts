import { setLastAPIRequest, setLastAPIRequestMessages } from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import { TICK_TAG } from '../constants/xml.js'
import type { LogOption } from '../types/logs.js'
import type { ApiRequestParams } from '../types/wire.js'
import { stripDisplayTags, stripDisplayTagsAllowEmpty } from './displayTags.js'
import { toError } from './errors.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'


export type ErrorLogSink = {
  logError: (error: Error) => void
  logMCPError: (serverName: string, error: unknown) => void
  logMCPDebug: (serverName: string, message: string) => void
  getErrorsPath: () => string
  getMCPLogsPath: (serverName: string) => string
}

type QueuedEvent =
  | { kind: 'error'; error: Error }
  | { kind: 'mcpError'; serverName: string; error: unknown }
  | { kind: 'mcpDebug'; serverName: string; message: string }

const IN_MEMORY_ERROR_CAP = 100

let sink: ErrorLogSink | null = null
const queue: QueuedEvent[] = []
const inMemoryErrors: { error: string; timestamp: string }[] = []

export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (sink) return
  sink = newSink
  const pending = queue.splice(0, queue.length)
  for (const event of pending) dispatch(newSink, event)
}

function dispatch(target: ErrorLogSink, event: QueuedEvent): void {
  switch (event.kind) {
    case 'error':
      target.logError(event.error)
      return
    case 'mcpError':
      target.logMCPError(event.serverName, event.error)
      return
    case 'mcpDebug':
      target.logMCPDebug(event.serverName, event.message)
      return
  }
}

function queueOrDispatch(event: QueuedEvent): void {
  if (sink) dispatch(sink, event)
  else queue.push(event)
}

function errorLoggingSuppressed(): boolean {
  if (process.env.DISABLE_ERROR_REPORTING) return true
  return isEssentialTrafficOnly()
}

export function logError(error: unknown): void {
  try {
    if (errorLoggingSuppressed()) return
    const coerced = toError(error)
    inMemoryErrors.push({ error: coerced.stack ?? coerced.message, timestamp: new Date().toISOString() })
    while (inMemoryErrors.length > IN_MEMORY_ERROR_CAP) inMemoryErrors.shift()
    queueOrDispatch({ kind: 'error', error: coerced })
  } catch {
  }
}

export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrors]
}

export function logMCPError(serverName: string, error: unknown): void {
  try {
    queueOrDispatch({ kind: 'mcpError', serverName, error })
  } catch {
  }
}

export function logMCPDebug(serverName: string, message: string): void {
  try {
    queueOrDispatch({ kind: 'mcpDebug', serverName, message })
  } catch {
  }
}


function isAutonomousPrompt(firstPrompt: string | undefined): boolean {
  return typeof firstPrompt === 'string' && firstPrompt.trimStart().startsWith(`<${TICK_TAG}`)
}

export function getLogDisplayTitle(log: LogOption, defaultTitle?: string): string {
  const autonomous = isAutonomousPrompt(log.firstPrompt)
  const strippedPrompt = log.firstPrompt ? stripDisplayTagsAllowEmpty(log.firstPrompt) : ''
  let title: string
  if (log.agentName) title = log.agentName
  else if (log.customTitle) title = log.customTitle
  else if (log.summary) title = log.summary
  else if (strippedPrompt.trim() !== '' && !autonomous) title = strippedPrompt
  else if (defaultTitle) title = defaultTitle
  else if (autonomous) title = 'Autonomous session'
  else if (log.sessionId) title = log.sessionId.slice(0, 8)
  else title = ''
  return stripDisplayTags(title).trim()
}


export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}


export function captureAPIRequest(params: ApiRequestParams, querySource?: QuerySource): void {
  if (!querySource || !String(querySource).startsWith('repl_main_thread')) return
  const { messages: _messages, ...rest } = params
  setLastAPIRequest(rest)
  setLastAPIRequestMessages(null)
}
