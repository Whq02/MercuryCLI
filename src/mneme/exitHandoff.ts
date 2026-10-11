import { getLastCacheSafeParams } from '../utils/forkedAgent.js'
import { askForHandoff, type AskRunner } from './handoffAsk.js'
import { ledgerEntryOf } from './ledger.js'
import { lineageKept, openLineageSession } from './lineageSession.js'

export const HANDOFF_EXIT_BUDGET_MS = 20_000
export const HANDOFF_EXIT_NOTICE = 'writing the handoff for the next session… (ctrl-c skips)'

export type ExitNoteOutcome = 'stored' | 'skipped' | 'none'

export function exitNoteDue(): boolean {
  if (!lineageKept()) return false
  const session = openLineageSession()
  if (session === null) return false
  const entry = ledgerEntryOf(session.projectKey, session.sessionId)
  if (entry === null || entry.handoff !== null) return false
  return getLastCacheSafeParams() !== null
}

export async function leaveNoteBeforeExit(opts: { signal?: AbortSignal; budgetMs?: number; run?: AskRunner } = {}): Promise<ExitNoteOutcome> {
  if (!exitNoteDue()) return 'skipped'
  const session = openLineageSession()!
  const params = getLastCacheSafeParams()!
  const note = await askForHandoff({
    cacheSafeParams: params,
    sessionId: session.sessionId,
    signal: opts.signal,
    budgetMs: opts.budgetMs ?? HANDOFF_EXIT_BUDGET_MS,
    run: opts.run,
  })
  return note === null ? 'none' : 'stored'
}
