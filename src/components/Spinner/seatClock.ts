interface SeatClockLedger {
  startMs: number
  pausedMs: number
  pauseStartMs: number | null
}

export function adoptSeatTurnStart(ledger: SeatClockLedger, started: number | null, nowMs: number): SeatClockLedger {
  if (started === null) return ledger.startMs === 0 ? { ...ledger, startMs: nowMs } : ledger
  if (started <= ledger.startMs) return { ...ledger, startMs: started }
  return {
    startMs: started,
    pausedMs: 0,
    pauseStartMs: ledger.pauseStartMs === null ? null : Math.max(ledger.pauseStartMs, started),
  }
}

export interface SeatClockAnchor {
  earliestStartMs: number
  startMs: number
  pausedMs: number
  carriedMs: number
}

export function anchorSeatClock(anchor: SeatClockAnchor | null, startMs: number, pausedMs: number): SeatClockAnchor {
  if (anchor === null) return { earliestStartMs: startMs, startMs, pausedMs, carriedMs: 0 }
  return {
    earliestStartMs: Math.min(anchor.earliestStartMs, startMs),
    startMs,
    pausedMs,
    carriedMs: startMs > anchor.startMs ? anchor.carriedMs + anchor.pausedMs : anchor.carriedMs,
  }
}

export function anchoredElapsedMs(anchor: SeatClockAnchor, nowMs: number, pauseHeldMs: number): number {
  return nowMs - anchor.earliestStartMs - anchor.carriedMs - anchor.pausedMs - pauseHeldMs
}
