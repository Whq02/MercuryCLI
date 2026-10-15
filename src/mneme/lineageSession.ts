import { getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import { decodeTranscriptBuffer } from '../fabric/transcriptDecode.js'
import type { Entry } from '../types/logs.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { logForDebugging } from '../utils/debug.js'
import { getTranscriptPathForSession, isTranscriptMessage } from '../utils/sessionStorage/paths.js'
import { readTranscriptTailSync } from '../utils/sessionStorage/transcriptReader.js'
import { closeEntry, ledgerClock, openEntry, reconcileInterruptedEntries, recordEngine, recordFact, recordFile, recordRuling } from './ledger.js'
import { mnemeEnabled } from './mnemeGates.js'
import { mnemeProjectKey } from './paths.js'
import { runSessionClosers, type SessionCloseContext } from './sessionClose.js'

interface OpenSession {
  projectKey: string
  sessionId: string
  engine: string
}

let open: OpenSession | null = null
let seen: OpenSession | null = null

const SESSION_CLOSERS_BUDGET_MS = 1_500

export function lineageKept(): boolean {
  return mnemeEnabled() && getInitialSettings().records?.retentionDays !== 0
}

export function lineageJoined(): boolean {
  return lineageKept() && !isSessionPersistenceDisabled()
}

export function openLineageSession(): OpenSession | null {
  return open
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024

const hasToolUse = (entry: Entry): boolean => {
  const content = (entry as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) && content.some(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_use')
}

function transcriptCutMidTool(sessionId: string): string | null {
  let tail: string
  try {
    tail = readTranscriptTailSync(getTranscriptPathForSession(sessionId), TRANSCRIPT_TAIL_BYTES)
  } catch {
    return null
  }
  if (tail === '') return null
  const lines = tail.split('\n')
  const whole = tail.length >= TRANSCRIPT_TAIL_BYTES ? lines.slice(1) : lines
  const { entries } = decodeTranscriptBuffer<Entry>(whole.join('\n'))
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (!isTranscriptMessage(entry)) continue
    const at = (entry as { timestamp?: unknown }).timestamp
    return entry.type === 'assistant' && hasToolUse(entry) && typeof at === 'string' ? at : null
  }
  return null
}

async function settle(session: OpenSession, outcome: string, budgetMs: number, kept: boolean): Promise<SessionCloseContext | null> {
  const entry = kept && lineageKept() ? closeEntry(session.projectKey, session.sessionId, { outcome }) : null
  const ctx: SessionCloseContext = {
    projectKey: session.projectKey,
    sessionId: session.sessionId,
    endedAt: entry?.endedAt ?? ledgerClock(),
    outcome,
    transcriptPath: getTranscriptPathForSession(session.sessionId),
    handoff: entry?.handoff?.text ?? null,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      runSessionClosers(ctx),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, budgetMs)
      }),
    ])
  } catch (error) {
    logForDebugging(`session closers failed for ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
  return ctx
}

export function noteSessionEngine(model: string): void {
  if (!mnemeEnabled()) return
  const sessionId = String(getSessionId())
  try {
    if (seen !== null && seen.sessionId === sessionId) {
      if (open !== null && open.engine !== model && lineageKept()) {
        recordEngine(open.projectKey, sessionId, model)
        open.engine = model
      }
      return
    }
    const previous = seen
    const previousOpen = open
    const projectKey = mnemeProjectKey()
    seen = { projectKey, sessionId, engine: model }
    if (lineageJoined()) {
      openEntry(projectKey, { sessionId, model })
      open = { projectKey, sessionId, engine: model }
      if (previous === null) reconcileInterruptedEntries(projectKey, sessionId, transcriptCutMidTool)
    } else open = null
    if (previous !== null) void settle(previous, 'cleared', SESSION_CLOSERS_BUDGET_MS, previousOpen !== null)
  } catch (error) {
    logForDebugging(`lineage session note failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function noteRetained(id: string, pinned: boolean): void {
  if (open === null || !lineageKept()) return
  recordFact(open.projectKey, open.sessionId, id, 'retained')
  if (pinned) recordRuling(open.projectKey, open.sessionId, id)
}

export function noteCorrected(id: string): void {
  if (open === null || !lineageKept()) return
  recordFact(open.projectKey, open.sessionId, id, 'corrected')
}

export function noteFileTouched(path: string): void {
  if (open === null || !lineageKept()) return
  recordFile(open.projectKey, open.sessionId, path)
}

export async function closeLineageSession(outcome: string, budgetMs: number = SESSION_CLOSERS_BUDGET_MS): Promise<SessionCloseContext | null> {
  const session = seen
  if (session === null) return null
  const kept = open !== null
  seen = null
  open = null
  return settle(session, outcome, budgetMs, kept)
}

export function _resetLineageSessionForTesting(): void {
  open = null
  seen = null
}
