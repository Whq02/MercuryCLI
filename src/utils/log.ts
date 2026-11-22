import { setLastAPIRequest } from '../bootstrap/state.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import type { QuerySource } from '../constants/querySource.js'
import { TICK_TAG } from '../constants/xml.js'
import type { SessionListing } from '../types/logs.js'
import type { ApiRequestParams } from '../types/wire.js'
import { stripDisplayTags, stripDisplayTagsAllowEmpty } from './displayTags.js'
import { toError } from './errors.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import { passedOver } from './passedOver.js'


type ErrorLogSink = {
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
  if (sink !== null) return
  sink = newSink
  for (const event of queue.splice(0)) dispatch(newSink, event)
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
  if (!flagEnabled('MERCURY_ERROR_REPORTING')) return true
  return isEssentialTrafficOnly()
}

export function logError(error: unknown): void {
  try {
    if (errorLoggingSuppressed()) return
    const coerced = toError(error)
    inMemoryErrors.push({ error: coerced.stack ?? coerced.message, timestamp: new Date().toISOString() })
    while (inMemoryErrors.length > IN_MEMORY_ERROR_CAP) inMemoryErrors.shift()
    queueOrDispatch({ kind: 'error', error: coerced })
  } catch (error) {
    passedOver(error)
  }
}

export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrors]
}

export function withoutStackFrames(text: string): string {
  return text.split('\n').filter(line => !/^\s+at (?:async )?\S/.test(line)).join('\n')
}

export function logMCPError(serverName: string, error: unknown): void {
  try {
    queueOrDispatch({ kind: 'mcpError', serverName, error })
  } catch (error) {
    passedOver(error)
  }
}

export function logMCPDebug(serverName: string, message: string): void {
  try {
    queueOrDispatch({ kind: 'mcpDebug', serverName, message })
  } catch (error) {
    passedOver(error)
  }
}


function isAutonomousPrompt(firstPrompt: string | undefined): boolean {
  return typeof firstPrompt === 'string' && firstPrompt.trimStart().startsWith(`<${TICK_TAG}`)
}

export function getLogDisplayTitle(log: SessionListing, defaultTitle?: string): string {
  const autonomous = isAutonomousPrompt(log.firstPrompt)
  const prompt = log.firstPrompt && !autonomous ? stripDisplayTagsAllowEmpty(log.firstPrompt).trim() : ''
  const title =
    log.agentName ||
    log.customTitle ||
    log.summary ||
    prompt ||
    defaultTitle ||
    (autonomous ? 'Autonomous session' : '') ||
    log.sessionId?.slice(0, 8) ||
    ''
  return stripDisplayTags(title).trim()
}


export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}


export function captureAPIRequest(params: ApiRequestParams, querySource?: QuerySource): void {
  if (!querySource || !String(querySource).startsWith('main_thread')) return
  const { messages: _messages, ...rest } = params
  setLastAPIRequest(rest)
}
