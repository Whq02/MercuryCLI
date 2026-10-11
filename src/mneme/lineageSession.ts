import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { getTranscriptPathForSession } from '../utils/sessionStorage/paths.js'
import { closeEntry, ledgerClock, openEntry, recordEngine, recordFact, recordFile, recordRuling } from './ledger.js'
import { mnemeEnabled } from './mnemeGates.js'
import { mnemeProjectKey } from './paths.js'
import { runSessionClosers, type SessionCloseContext } from './sessionClose.js'

interface OpenSession {
  projectKey: string
  sessionId: string
  engine: string
}

let open: OpenSession | null = null

export const SESSION_CLOSERS_BUDGET_MS = 1_500

export function openLineageSession(): OpenSession | null {
  return open
}

async function settle(session: OpenSession, outcome: string, budgetMs: number): Promise<SessionCloseContext | null> {
  const entry = closeEntry(session.projectKey, session.sessionId, { outcome })
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
    if (open !== null && open.sessionId === sessionId) {
      if (open.engine !== model) {
        recordEngine(open.projectKey, sessionId, model)
        open.engine = model
      }
      return
    }
    const previous = open
    const projectKey = mnemeProjectKey()
    openEntry(projectKey, { sessionId, model })
    open = { projectKey, sessionId, engine: model }
    if (previous !== null) void settle(previous, 'cleared', SESSION_CLOSERS_BUDGET_MS)
  } catch (error) {
    logForDebugging(`lineage session note failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function noteRetained(id: string, pinned: boolean): void {
  if (open === null) return
  recordFact(open.projectKey, open.sessionId, id, 'retained')
  if (pinned) recordRuling(open.projectKey, open.sessionId, id)
}

export function noteCorrected(id: string): void {
  if (open === null) return
  recordFact(open.projectKey, open.sessionId, id, 'corrected')
}

export function noteFileTouched(path: string): void {
  if (open === null) return
  recordFile(open.projectKey, open.sessionId, path)
}

export async function closeLineageSession(outcome: string, budgetMs: number = SESSION_CLOSERS_BUDGET_MS): Promise<SessionCloseContext | null> {
  const session = open
  if (session === null) return null
  open = null
  return settle(session, outcome, budgetMs)
}

export function _resetLineageSessionForTesting(): void {
  open = null
}
