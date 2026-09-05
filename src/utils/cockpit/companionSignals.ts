
import type { Message } from '../../types/message.js'

export interface CompanionTurnSignals {
  turnLive: boolean
  turnStartTs: number | null
  streaming: boolean
  awaitingPermission: boolean
  lastTurnEndTs: number | null
  lastTurnDurationMs: number | null
  lastTurnEndedInError: boolean
  lastTurnErrorTs: number | null
}

export function turnEndedInError(records: readonly Message[]): boolean {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!
    if (record.type === 'assistant') return record.isApiErrorMessage === true
    if (record.type === 'user' && record.isMeta !== true) return false
  }
  return false
}

let signals: CompanionTurnSignals = {
  turnLive: false,
  turnStartTs: null,
  streaming: false,
  awaitingPermission: false,
  lastTurnEndTs: null,
  lastTurnDurationMs: null,
  lastTurnEndedInError: false,
  lastTurnErrorTs: null,
}

let version = 0
const listeners = new Set<() => void>()

export function publishCompanionTurn(next: {
  turnLive: boolean
  streaming: boolean
  awaitingPermission: boolean
  endedInError?: boolean
}): void {
  publishCompanionTurnAt(next, Date.now())
}

export function publishCompanionTurnAt(
  next: { turnLive: boolean; streaming: boolean; awaitingPermission: boolean; endedInError?: boolean },
  now: number,
): void {
  const wasLive = signals.turnLive
  const endedInError = !next.turnLive && next.endedInError === true
  if (
    wasLive === next.turnLive &&
    signals.streaming === next.streaming &&
    signals.awaitingPermission === next.awaitingPermission &&
    signals.lastTurnEndedInError === endedInError
  ) {
    return
  }
  const ending = wasLive && !next.turnLive
  const errorArrived = endedInError && !signals.lastTurnEndedInError
  signals = {
    turnLive: next.turnLive,
    turnStartTs: next.turnLive ? (wasLive ? signals.turnStartTs : now) : null,
    streaming: next.streaming,
    awaitingPermission: next.awaitingPermission,
    lastTurnEndTs: ending ? now : signals.lastTurnEndTs,
    lastTurnDurationMs:
      ending && signals.turnStartTs !== null ? Math.max(0, now - signals.turnStartTs) : signals.lastTurnDurationMs,
    lastTurnEndedInError: endedInError,
    lastTurnErrorTs: errorArrived ? now : signals.lastTurnErrorTs,
  }
  version += 1
  for (const cb of listeners) cb()
}

export function companionTurnSignals(): CompanionTurnSignals {
  return signals
}

export function getCompanionSignalsVersion(): number {
  return version
}

export function subscribeCompanionSignals(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function resetCompanionSignals(): void {
  signals = {
    turnLive: false,
    turnStartTs: null,
    streaming: false,
    awaitingPermission: false,
    lastTurnEndTs: null,
    lastTurnDurationMs: null,
    lastTurnEndedInError: false,
    lastTurnErrorTs: null,
  }
  version += 1
}
