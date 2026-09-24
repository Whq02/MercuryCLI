import { getFocusedSessionConnector, hasFocusedSession, subscribeThroughFocused } from '../engine-connector/focusedConnector.js'
import type { JevFactsV1 } from '../engine-connector/types.js'
import type { JevStatus, JevStatusKind } from './jevContract.js'
import { type JevKeyPresence, jevKeyPresence } from './jevKey.js'
import type { JevLedgerSnapshot } from './jevLedger.js'
import { type JevSettings, readJevSettings } from './jevSetting.js'
import { JEV_STATUS_HEADWORDS, jevSharedStatus } from './jevStatus.js'

export type JevSessionFacts = { state: 'reported'; facts: JevFactsV1 } | { state: 'unknown' } | { state: 'no-session' }

export const JEV_SPEND_UNREPORTED_WORDS = 'session spend not reported'
export const JEV_NO_SESSION_WORDS = 'no chat open'
export const JEV_SPEND_UNREPORTED_SHORT_WORDS = 'spend not reported'
export const JEV_NO_SESSION_SHORT_WORDS = 'no chat'

export function jevFactsOf(ledger: JevLedgerSnapshot, status: JevStatus): JevFactsV1 {
  return {
    spendUsd: ledger.spendUsd,
    calls: ledger.calls,
    attempts: ledger.attempts,
    inputTokens: ledger.inputTokens,
    unconfirmedCharges: ledger.unconfirmedCharges,
    holdUntilMs: ledger.holdUntil,
    refusals: ledger.refusals,
    lastAnsweredAtMs: ledger.lastAnsweredAt,
    lastModel: ledger.lastModel,
    status: { kind: status.kind, words: status.words },
  }
}

type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const pick = (row: Row, internal: string, wire: string): unknown => (internal in row ? row[internal] : row[wire])

export function jevFactsOfRow(value: unknown): JevFactsV1 | undefined {
  if (!isRow(value)) return undefined
  const spendUsd = pick(value, 'spendUsd', 'spend_usd')
  const inputTokens = pick(value, 'inputTokens', 'input_tokens')
  const unconfirmedCharges = pick(value, 'unconfirmedCharges', 'unconfirmed_charges')
  const holdUntilMs = pick(value, 'holdUntilMs', 'hold_until_ms')
  const lastAnsweredAtMs = pick(value, 'lastAnsweredAtMs', 'last_answered_at_ms')
  const lastModel = pick(value, 'lastModel', 'last_model')
  const { calls, attempts, refusals, status } = value
  if (!finite(spendUsd) || !finite(calls) || !finite(attempts) || !finite(inputTokens) || !finite(unconfirmedCharges) || !finite(holdUntilMs) || !finite(refusals)) return undefined
  const answeredAt = lastAnsweredAtMs === null ? null : finite(lastAnsweredAtMs) ? lastAnsweredAtMs : undefined
  if (answeredAt === undefined) return undefined
  const model = lastModel === null ? null : typeof lastModel === 'string' ? lastModel : undefined
  if (model === undefined) return undefined
  if (!isRow(status) || typeof status.kind !== 'string' || !Object.hasOwn(JEV_STATUS_HEADWORDS, status.kind) || typeof status.words !== 'string') return undefined
  return {
    spendUsd,
    calls,
    attempts,
    inputTokens,
    unconfirmedCharges,
    holdUntilMs,
    refusals,
    lastAnsweredAtMs: answeredAt,
    lastModel: model,
    status: { kind: status.kind as JevStatusKind, words: status.words },
  }
}

export function jevSessionFacts(): JevSessionFacts {
  if (!hasFocusedSession()) return { state: 'no-session' }
  const facts = jevFactsOfRow(getFocusedSessionConnector().usage().jev)
  return facts === undefined ? { state: 'unknown' } : { state: 'reported', facts }
}

export function jevSessionStatus(session: JevSessionFacts = jevSessionFacts(), settings: JevSettings = readJevSettings(), key: JevKeyPresence = jevKeyPresence()): JevStatus {
  if (session.state === 'reported') return { kind: session.facts.status.kind, words: session.facts.status.words }
  return jevSharedStatus(settings, key)
}

export function jevSessionAbsenceWords(session: Exclude<JevSessionFacts, { state: 'reported' }>): string {
  return session.state === 'no-session' ? JEV_NO_SESSION_WORDS : JEV_SPEND_UNREPORTED_WORDS
}

export function jevSessionAbsenceShortWords(session: Exclude<JevSessionFacts, { state: 'reported' }>): string {
  return session.state === 'no-session' ? JEV_NO_SESSION_SHORT_WORDS : JEV_SPEND_UNREPORTED_SHORT_WORDS
}

export const subscribeJevSessionFacts = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))

export function jevSessionFactsStamp(): string {
  return JSON.stringify(jevSessionFacts())
}
