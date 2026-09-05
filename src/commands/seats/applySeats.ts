import type { LocalCommandCall } from '../../types/command.js'
import {
  SEAT_COST_BYTES,
  SEAT_DOORS,
  seatCeilingFacts,
  seatCeilingValueWords,
  seatCostWarning,
  seatSourceWords,
  setOperatorSeats,
  type SeatCeilingFacts,
} from '../../services/switchboard/capacityCheck.js'


export function parseSeatsArg(input: string): number | 'auto' | undefined {
  const s = input.trim().toLowerCase()
  if (s === '') return undefined
  if (s === 'auto' || s === 'reset' || s === 'unset' || s === 'default') return 'auto'
  if (!/^\d+$/.test(s)) return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n >= 1 ? n : undefined
}

function inputsClause(facts: SeatCeilingFacts): string {
  const at = facts.readingSentence.indexOf(' (')
  return at === -1 ? '' : facts.readingSentence.slice(at)
}

const RUNNER_MB = Math.round(SEAT_COST_BYTES.runner / 2 ** 20)

export function seatsStatus(facts: SeatCeilingFacts = seatCeilingFacts()): string {
  const head =
    facts.source === 'machine'
      ? `Seats: ${seatCeilingValueWords(facts)}${inputsClause(facts)}`
      : `Seats: ${seatCeilingValueWords(facts)} — ${facts.readingSentence}`
  const lines = [head]
  const warning = seatCostWarning(facts)
  if (warning !== null) lines.push(`Note: ${warning}.`)
  lines.push(
    'Sessions, sub-agents and workflow agents run under this one number. A seat is held only while a model call is in flight — an idle agent holds none — and a call past the ceiling waits with its row saying so.',
    `/seats N sets the ceiling (a whole number, no upper clamp; above the reading each seat may cost a runner process of about ${RUNNER_MB} MB) · /seats auto returns to the machine's reading · the same setting is the Seats row of the Boot Menu and of /config.`,
  )
  return lines.join('\n')
}

export function applySeats(arg: string): string {
  const parsed = parseSeatsArg(arg)
  if (arg.trim() === '') return seatsStatus()
  if (parsed === undefined) return `/seats takes a whole number of 1 or more, or auto — e.g. /seats 8 · /seats auto. Doors: ${SEAT_DOORS}.`
  if (parsed === 'auto') {
    const facts = setOperatorSeats(null)
    return `Seats follow ${seatSourceWords(facts.source)} again: ${facts.seats}${facts.source === 'machine' ? inputsClause(facts) : ` — ${facts.readingSentence}`}. Applies to the next admission at once.`
  }
  const facts = setOperatorSeats(parsed)
  const lines = [`Seats set to ${facts.seats} · set by you — applies to the next admission at once (the daemon on its next spawn).`]
  const warning = seatCostWarning(facts)
  if (warning !== null) lines.push(`Note: ${warning}.`)
  return lines.join('\n')
}

export const call: LocalCommandCall = async args => ({ type: 'text', value: applySeats(args) })
