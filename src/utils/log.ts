import { setLastAPIRequest, setLastAPIRequestMessages } from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import { TICK_TAG } from '../constants/xml.js'
import type { LogOption } from '../types/logs.js'
import type { ApiRequestParams } from '../types/wire.js'
import { stripDisplayTags, stripDisplayTagsAllowEmpty } from './displayTags.js'
import { toError } from './errors.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'

/**
 * Error logging decoupled from its backing store (attached late without
 * losing early errors), the in-memory error ring, session display titles,
 * and the API request capture for bug reports.
 */

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

/** Idempotent: a second attachment is a silent no-op. Drains the queue at once, in order. */
export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (sink) return
  sink = newSink
  // Empty the queue before draining so re-entrancy cannot double-deliver.
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

/** Never throws. */
export function logError(error: unknown): void {
  try {
    if (errorLoggingSuppressed()) return
    const coerced = toError(error)
    inMemoryErrors.push({ error: coerced.stack ?? coerced.message, timestamp: new Date().toISOString() })
    while (inMemoryErrors.length > IN_MEMORY_ERROR_CAP) inMemoryErrors.shift()
    queueOrDispatch({ kind: 'error', error: coerced })
  } catch {
    // A failure inside error logging never propagates.
  }
}

/** A copy of the ring — bug reports and the recent-errors surface read it. */
export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrors]
}

export function logMCPError(serverName: string, error: unknown): void {
  try {
    queueOrDispatch({ kind: 'mcpError', serverName, error })
  } catch {
    // Swallowed.
  }
}

export function logMCPDebug(serverName: string, message: string): void {
  try {
    queueOrDispatch({ kind: 'mcpDebug', serverName, message })
  } catch {
    // Swallowed.
  }
}

// ---------------------------------------------------------------------------
// Session display titles
// ---------------------------------------------------------------------------

/** An autonomous-mode auto-prompt opens with the tick tag; never a title. */
function isAutonomousPrompt(firstPrompt: string | undefined): boolean {
  return typeof firstPrompt === 'string' && firstPrompt.trimStart().startsWith(`<${TICK_TAG}`)
}

export function getLogDisplayTitle(log: LogOption, defaultTitle?: string): string {
  const autonomous = isAutonomousPrompt(log.firstPrompt)
  // The allow-empty variant is load-bearing: a prompt that was only a
  // command marker must become empty here so the resolution moves on.
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

// ---------------------------------------------------------------------------
// Log filenames
// ---------------------------------------------------------------------------

/** The on-disk filename shape: ISO with colons and dots replaced by hyphens. */
export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

// ---------------------------------------------------------------------------
// API request capture (bug reports)
// ---------------------------------------------------------------------------

/**
 * Only the main conversation thread (a prefix match — non-default output
 * styles produce suffixed variants). The messages array is removed before
 * storing: the capture exists for a report most sessions never file and must
 * not hold a second copy of the conversation alive.
 */
export function captureAPIRequest(params: ApiRequestParams, querySource?: QuerySource): void {
  if (!querySource || !String(querySource).startsWith('repl_main_thread')) return
  const { messages: _messages, ...rest } = params
  setLastAPIRequest(rest)
  setLastAPIRequestMessages(null)
}
