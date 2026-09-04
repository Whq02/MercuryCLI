
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

function holderList(holders: readonly string[]): string {
  return holders.length === 0 ? '' : ` (${holders.join(', ')})`
}

export function seatWaitWords(facts: SeatWaitFacts): string {
  const held = `${Math.min(facts.holders.length, facts.width)} of ${facts.width} held${holderList(facts.holders)}`
  const narrowed = seatNarrowingWords(facts.narrowing)
  if (narrowed !== null) return `waiting for a lane — ${narrowed} — ${held}`
  return `waiting for a seat — ${held}`
}

export const SEAT_WAIT_STATUS_WORD = 'waiting'
