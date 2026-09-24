import { getFocusedSessionConnector, hasFocusedSession, subscribeThroughFocused } from '../engine-connector/focusedConnector.js'
import type { JevFactsV1 } from '../engine-connector/types.js'
import type { JevStatus } from './jevContract.js'
import { type JevKeyPresence, jevKeyPresence } from './jevKey.js'
import type { JevLedgerSnapshot } from './jevLedger.js'
import { type JevSettings, readJevSettings } from './jevSetting.js'
import { jevSharedStatus } from './jevStatus.js'

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

export function jevSessionFacts(): JevSessionFacts {
  if (!hasFocusedSession()) return { state: 'no-session' }
  const facts = getFocusedSessionConnector().usage().jev
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
