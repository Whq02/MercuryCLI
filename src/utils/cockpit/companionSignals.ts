// ============================================================================
//  companionSignals — the in-process turn-signal seam for the deck companion.
//
//  The REPL owns the live turn facts (a turn is in flight, streaming text is
//  flowing, a permission ask is pending) as local React state, so the pinned
//  DeckPane can't read them without prop-drilling through FullscreenLayout.
//  Same seam shape as contextUsageLive.ts: the REPL PUBLISHES coarse booleans
//  from one effect, this module stores them, and the DeckCompanion row
//  subscribes (useSyncExternalStore) and derives its mood via buddyStateFor.
//
//  HONEST BY CONSTRUCTION: every field is a fact the REPL already renders
//  elsewhere (spinner, permission dialog); nothing is inferred or invented
//  here. Edge stamps (turn end) are recorded at publish time so the reader
//  can derive settle/idle windows without its own clock bookkeeping.
//
//  No React, no I/O, module-scoped. Version bumps ONLY on a real change so a
//  streaming turn's repeated identical publishes never re-render subscribers.
// ============================================================================

export interface CompanionTurnSignals {
  /** A turn is in flight right now (the REPL's isLoading). */
  turnLive: boolean
  /** Epoch ms when the live turn started; null when no turn is live. */
  turnStartTs: number | null
  /** Token-level streaming text is visibly flowing (the thinking signal). */
  streaming: boolean
  /** A tool-permission ask is pending on the operator (blocked-on-you). */
  awaitingPermission: boolean
  /** Epoch ms when the last turn ended (live true→false edge); null before
   *  any turn has completed this session. */
  lastTurnEndTs: number | null
  /** How long the last turn ran live (end − start); null before any turn
   *  has completed this session. The voice's long-run threshold reads it. */
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

/**
 * Publish the REPL's live turn facts. Call with the CURRENT booleans; the
 * store derives the edges (turn start stamps turnStartTs, turn end stamps
 * lastTurnEndTs). Idempotent for identical states — no version bump, no
 * listener churn on a no-op publish.
 */
export function publishCompanionTurn(next: {
  turnLive: boolean
  streaming: boolean
  awaitingPermission: boolean
}): void {
  publishCompanionTurnAt(next, Date.now())
}

/** The same publish with an explicit clock — the proof seam for the edge
 *  stamps (a long-run settle is minutes apart; a prover pins the clock). */
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

/** The latest published turn facts (read at render by DeckCompanion). */
export function companionTurnSignals(): CompanionTurnSignals {
  return signals
}

/** Monotonic version — the useSyncExternalStore snapshot (the object above is
 *  replaced wholesale per change, but a primitive keeps Object.is exact). */
export function getCompanionSignalsVersion(): number {
  return version
}

export function subscribeCompanionSignals(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Test/proof seam: reset to the boot state (session code never calls this). */
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
