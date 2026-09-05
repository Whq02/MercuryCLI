
export type SeatNarrowing =
  | { by: 'profile'; band: 1 | 2; profileId: string }
  | { by: 'operator'; lanes: number }
  | null

export interface SeatWaitFacts {
  width: number
  holders: readonly string[]
  narrowing: SeatNarrowing
}

export const CHAT_HOLDER = 'the chat'

export function seatNarrowingWords(narrowing: SeatNarrowing): string | null {
  if (narrowing === null) return null
  if (narrowing.by === 'profile') {
    const lanes = narrowing.band === 1 ? '1 lane' : `${narrowing.band} lanes`
    return `delegation narrowed to ${lanes} by the ${narrowing.band === 1 ? 'solo' : 'paired'} profile ${narrowing.profileId} (its delegation width, band ${narrowing.band})`
  }
  return `delegation narrowed to ${narrowing.lanes} lane${narrowing.lanes === 1 ? '' : 's'} by MERCURY_MODEL_LANES=${narrowing.lanes}`
}

export function seatWaitParts(facts: SeatWaitFacts): { gate: string; holders: string } {
  const held = `${Math.min(facts.holders.length, facts.width)} of ${facts.width} held`
  const narrowed = seatNarrowingWords(facts.narrowing)
  const gate = narrowed !== null ? `waiting for a lane — ${narrowed} — ${held}` : `waiting for a seat — ${held}`
  return { gate, holders: facts.holders.join(', ') }
}

export function seatWaitWords(facts: SeatWaitFacts): string {
  const { gate, holders } = seatWaitParts(facts)
  return holders === '' ? gate : `${gate} (${holders})`
}

export function splitWaitSentence(sentence: string): { gate: string; holders: string } {
  const m = /^(.*\bheld) \((.*)\)$/.exec(sentence)
  return m === null ? { gate: sentence, holders: '' } : { gate: m[1]!, holders: m[2]! }
}

export const SEAT_WAIT_STATUS_WORD = 'waiting'
