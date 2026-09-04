import { harnessEffortFact, resolveActiveHarnessProfile } from '../mission/harnessApplication.js'
import type { EffortValue } from '../../utils/effort.js'
import { harnessProfileById } from '../mission/harnessProfiles.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { seatCeilingFacts, type SeatCeilingSource } from '../switchboard/capacityCheck.js'
import { governorCeilings, setGovernorCeilings, type CeilingProvenance, type GovernorCeilings } from './governor.js'
import type { SeatNarrowing } from './seatWords.js'

export interface CeilingFacts {
  seats: number
  seatSource: SeatCeilingSource | 'inherited'
  delegationBand: 1 | 2 | 3 | null
  profileId: string | null
  operatorLanes: number | null
}

export function composeGovernorCeilings(facts: CeilingFacts): GovernorCeilings {
  const seats = Math.max(1, Math.floor(facts.seats))
  const operator = facts.operatorLanes !== null && facts.operatorLanes >= 1 ? Math.floor(facts.operatorLanes) : Infinity
  const cap = (n: number): number => Math.max(1, Math.min(n, operator))
  const delegation = facts.delegationBand === 1 ? 1 : facts.delegationBand === 2 ? 2 : seats
  return { modelLanes: cap(seats), delegationLanes: cap(Math.min(delegation, seats)) }
}

export function composeProvenance(facts: CeilingFacts, composed: GovernorCeilings): CeilingProvenance {
  const seats = Math.max(1, Math.floor(facts.seats))
  let narrowing: SeatNarrowing = null
  if (composed.delegationLanes < seats) {
    if ((facts.delegationBand === 1 || facts.delegationBand === 2) && facts.delegationBand <= composed.delegationLanes) {
      narrowing = { by: 'profile', band: facts.delegationBand, profileId: facts.profileId ?? 'the active profile' }
    } else if (facts.operatorLanes !== null && facts.operatorLanes >= 1) {
      narrowing = { by: 'operator', lanes: Math.floor(facts.operatorLanes) }
    } else if (facts.delegationBand === 1 || facts.delegationBand === 2) {
      narrowing = { by: 'profile', band: facts.delegationBand, profileId: facts.profileId ?? 'the active profile' }
    }
  }
  return { seats, seatSource: facts.seatSource, narrowing }
}

function liveDelegationBand(
  model: string | null | undefined,
  sessionEffortValue: EffortValue | undefined,
): { band: 1 | 2 | 3 | null; profileId: string | null } {
  try {
    const resolution = resolveActiveHarnessProfile({ model, effortLevel: harnessEffortFact(model, sessionEffortValue) })
    if (!resolution) return { band: null, profileId: null }
    const lanes = harnessProfileById(resolution.profileId)?.axes.delegationTopology.maxConcurrentLanes
    return { band: lanes === 1 || lanes === 2 || lanes === 3 ? lanes : null, profileId: resolution.profileId }
  } catch {
    return { band: null, profileId: null }
  }
}

export function operatorLanesFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['MERCURY_MODEL_LANES'] ?? ''
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

export function inheritedSeatsFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env['MERCURY_SEATS'] ?? ''
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

export function seatsForProcess(): { seats: number; source: SeatCeilingSource | 'inherited' } {
  const inherited = inheritedSeatsFromEnv({ MERCURY_SEATS: flagEnv('MERCURY_SEATS') ?? '' })
  if (inherited !== null) return { seats: inherited, source: 'inherited' }
  const facts = seatCeilingFacts()
  return { seats: facts.seats, source: facts.source }
}

let lastApplied: string | null = null

export function liveCeilingFacts(model: string | null | undefined, sessionEffortValue?: EffortValue): CeilingFacts {
  const seats = seatsForProcess()
  const band = liveDelegationBand(model, sessionEffortValue)
  return {
    seats: seats.seats,
    seatSource: seats.source,
    delegationBand: band.band,
    profileId: band.profileId,
    operatorLanes: operatorLanesFromEnv(),
  }
}

export function refreshGovernorCeilings(
  model: string | null | undefined,
  sessionEffortValue?: EffortValue,
): GovernorCeilings {
  const facts = liveCeilingFacts(model, sessionEffortValue)
  const composed = composeGovernorCeilings(facts)
  const provenance = composeProvenance(facts, composed)
  const key = `${composed.modelLanes}:${composed.delegationLanes}:${provenance.seatSource}:${JSON.stringify(provenance.narrowing)}`
  if (key !== lastApplied) {
    lastApplied = key
    setGovernorCeilings(composed, provenance)
  }
  return governorCeilings()
}

export function _resetComposeCeilingsForTesting(): void {
  lastApplied = null
}
