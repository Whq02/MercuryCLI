interface InterruptLatchV1 {

  readonly pressedAtMs: number
}

interface InterruptLatchFactsV1 {

  inFlight: boolean

  turnStartedAtMs: number | null
}

type InterruptLatchReleaseV1 = 'idle' | 'later-turn'

export function interruptLatchRelease(latch: InterruptLatchV1, facts: InterruptLatchFactsV1): InterruptLatchReleaseV1 | null {
  if (!facts.inFlight) return 'idle'
  if (facts.turnStartedAtMs !== null && facts.turnStartedAtMs >= latch.pressedAtMs) return 'later-turn'
  return null
}
