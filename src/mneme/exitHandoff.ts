import { getLastCacheSafeParams } from '../utils/forkedAgent.js'
import { isUnattendedRun } from '../utils/cockpit/runtimePosture.js'
import type { NonNullableUsage } from '../services/api/emptyUsage.js'
import { askForHandoff, handoffAsked, handoffNotice, inThousands, type AskRunner } from './handoffAsk.js'
import { ledgerEntryOf } from './ledger.js'
import { lineageJoined, openLineageSession } from './lineageSession.js'

export const HANDOFF_EXIT_BUDGET_MS = 20_000
export const HANDOFF_EXIT_NOTICE = 'writing the handoff for the next session… (ctrl-c skips)'

export type ExitNoteOutcome = 'stored' | 'skipped' | 'none'

let keptChars: number | null = null

export function exitNoteCharsKept(): number | null {
  return keptChars
}

export function exitFarewell(farewell: string, note: ExitNoteOutcome, chars: number | null | undefined): string {
  if (note !== 'stored' || chars === null || chars === undefined) return farewell
  const [first, ...rest] = farewell.split('. ')
  return `${first}, note kept (${inThousands(chars)} characters).${rest.length > 0 ? ` ${rest.join('. ')}` : ''}`
}

export function exitNoteDue(): boolean {
  if (!lineageJoined() || isUnattendedRun()) return false
  const session = openLineageSession()
  if (session === null || handoffAsked(session.sessionId)) return false
  const entry = ledgerEntryOf(session.projectKey, session.sessionId)
  if (entry === null || entry.handoff !== null) return false
  return getLastCacheSafeParams() !== null
}

export async function leaveNoteBeforeExit(opts: { signal?: AbortSignal; budgetMs?: number; run?: AskRunner; onNotice?: (text: string) => void; onUsage?: (usage: NonNullableUsage) => void } = {}): Promise<ExitNoteOutcome> {
  if (!exitNoteDue()) return 'skipped'
  const session = openLineageSession()!
  const params = getLastCacheSafeParams()!
  const note = await askForHandoff({
    cacheSafeParams: params,
    sessionId: session.sessionId,
    signal: opts.signal,
    budgetMs: opts.budgetMs ?? HANDOFF_EXIT_BUDGET_MS,
    run: opts.run,
    onUsage: opts.onUsage,
  })
  if (note === null) return 'none'
  if (!note.stored) {
    const notice = handoffNotice(note)
    if (opts.onNotice) opts.onNotice(notice)
    else process.stderr.write(`${notice}\n`)
    return 'none'
  }
  keptChars = note.text.length
  return 'stored'
}
