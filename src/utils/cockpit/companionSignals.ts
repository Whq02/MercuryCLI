
export interface CompanionTurnSignals {
  turnLive: boolean
  turnStartTs: number | null
  streaming: boolean
  awaitingPermission: boolean
  lastTurnEndTs: number | null
  lastTurnDurationMs: number | null
}

let signals: CompanionTurnSignals = {
  turnLive: false,
  turnStartTs: null,
  streaming: false,
  awaitingPermission: false,
  lastTurnEndTs: null,
  lastTurnDurationMs: null,
}

let version = 0
const listeners = new Set<() => void>()

export function publishCompanionTurn(next: {
  turnLive: boolean
  streaming: boolean
  awaitingPermission: boolean
}): void {
  publishCompanionTurnAt(next, Date.now())
}

export function publishCompanionTurnAt(
  next: { turnLive: boolean; streaming: boolean; awaitingPermission: boolean },
  now: number,
): void {
  const wasLive = signals.turnLive
  if (
    wasLive === next.turnLive &&
    signals.streaming === next.streaming &&
    signals.awaitingPermission === next.awaitingPermission
  ) {
    return
  }
  const ending = wasLive && !next.turnLive
  signals = {
    turnLive: next.turnLive,
    turnStartTs: next.turnLive ? (wasLive ? signals.turnStartTs : now) : null,
    streaming: next.streaming,
    awaitingPermission: next.awaitingPermission,
    lastTurnEndTs: ending ? now : signals.lastTurnEndTs,
    lastTurnDurationMs:
      ending && signals.turnStartTs !== null ? Math.max(0, now - signals.turnStartTs) : signals.lastTurnDurationMs,
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
  }
  version += 1
}
