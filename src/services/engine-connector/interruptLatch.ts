
export interface InterruptLatchV1 {
  readonly pressedAtMs: number
}

export interface InterruptLatchFactsV1 {
  inFlight: boolean
  turnStartedAtMs: number | null
}

export type InterruptLatchReleaseV1 = 'idle' | 'later-turn'

export function interruptLatchRelease(latch: InterruptLatchV1, facts: InterruptLatchFactsV1): InterruptLatchReleaseV1 | null {
  if (!facts.inFlight) return 'idle'
  if (facts.turnStartedAtMs !== null && facts.turnStartedAtMs >= latch.pressedAtMs) return 'later-turn'
  return null
}
