import { flagEnv } from '../substrate/flagRegistry.js'

export type CapPosture = 'off' | 'offer' | 'auto'

export type CapQuota = 'allowed' | 'allowed_warning' | 'rejected'

export type CapAction =
  | { kind: 'none' }
  | {
      kind: 'offer'
      trigger: 'warning' | 'rejected' | 'reset'
    }
  | { kind: 'auto-handoff'; trigger: 'rejected' | 'reset' }

export function resolveCapPosture(): CapPosture {
  const raw = flagEnv('MERCURY_CAP_FAILOVER')
  return raw === 'off' || raw === 'auto' ? raw : 'offer'
}

export function decideCapAction(posture: CapPosture, quota: CapQuota): CapAction {
  if (posture === 'off') return { kind: 'none' }
  if (quota === 'allowed') return { kind: 'none' }
  if (quota === 'allowed_warning') return { kind: 'offer', trigger: 'warning' }
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'rejected' }
    : { kind: 'offer', trigger: 'rejected' }
}

let capHandoff: { homeModel: string | null } | null = null

export function noteCapHandoff(homeModel: string | null): void {
  capHandoff = { homeModel }
}

export function noteCapReturn(): void {
  capHandoff = null
}

export function capHandoffState(): { homeModel: string | null } | null {
  return capHandoff
}


const offerDismissals = new Set<string>()
const offerAutoActions = new Set<string>()

export function offerDismissed(key: string): boolean {
  return offerDismissals.has(key)
}

export function noteOfferDismissal(key: string): void {
  offerDismissals.add(key)
}

export function offerAutoDone(key: string): boolean {
  return offerAutoActions.has(key)
}

export function noteOfferAutoDone(key: string): void {
  offerAutoActions.add(key)
}

export function _resetOfferMemoriesForTesting(): void {
  offerDismissals.clear()
  offerAutoActions.clear()
}

export function decideCapReturn(
  posture: CapPosture,
  homeQuota: CapQuota,
  onFailoverLane: boolean,
): CapAction {
  if (!onFailoverLane || posture === 'off') return { kind: 'none' }
  if (homeQuota !== 'allowed') return { kind: 'none' }
  return posture === 'auto'
    ? { kind: 'auto-handoff', trigger: 'reset' }
    : { kind: 'offer', trigger: 'reset' }
}


export type SlotWallAction = { kind: 'none' } | { kind: 'offer' } | { kind: 'auto-switch' }

export function decideSlotWallAction(
  posture: CapPosture,
  facts: { activeWalled: boolean; otherSignedIn: boolean; otherWalled: boolean },
): SlotWallAction {
  if (!facts.activeWalled || !facts.otherSignedIn || facts.otherWalled) return { kind: 'none' }
  return posture === 'auto' ? { kind: 'auto-switch' } : { kind: 'offer' }
}


export const CAP_FAILOVER_FAMILY_ORDER = [
  'openai',
  'zai',
  'moonshot',
  'deepseek',
  'huggingface',
  'openrouter',
  'gemini',
  'openai-compat',
  'local',
] as const

export type CapFailoverRoute = (typeof CAP_FAILOVER_FAMILY_ORDER)[number]

export interface CapFailoverCandidate {
  route: CapFailoverRoute
  model: string
}

export interface CapFailoverExclusion {
  route: CapFailoverRoute
  why: string
}

export interface CapFailoverCandidateSet {
  candidates: CapFailoverCandidate[]
  excluded: CapFailoverExclusion[]
}

export function deriveCapFailoverCandidates(
  usability: Record<string, { usable: boolean; blockers: string[] }>,
  targetModelOf: (route: CapFailoverRoute) => string | undefined,
): CapFailoverCandidateSet {
  const candidates: CapFailoverCandidate[] = []
  const excluded: CapFailoverExclusion[] = []
  for (const route of CAP_FAILOVER_FAMILY_ORDER) {
    const lane = usability[route]
    if (lane === undefined || !lane.usable) {
      excluded.push({
        route,
        why: lane !== undefined && lane.blockers.length > 0 ? lane.blockers.join(' · ') : 'lane not usable',
      })
      continue
    }
    const model = targetModelOf(route)
    if (model === undefined || model.trim() === '') {
      excluded.push({ route, why: 'no recorded target model fact — never a guessed id' })
      continue
    }
    candidates.push({ route, model })
  }
  return { candidates, excluded }
}

export function liveCapFailoverCandidates(): CapFailoverCandidateSet {
  const { resolveProviderUsability } =
    require('./providers/providerUsability.js') as typeof import('./providers/providerUsability.js')
  const { getGptSeatAvailability } =
    require('./providers/openai/openaiCatalogue.js') as typeof import('./providers/openai/openaiCatalogue.js')
  const { providerFrontierFact } =
    require('../utils/model/providerFrontier.js') as typeof import('../utils/model/providerFrontier.js')
  return deriveCapFailoverCandidates(resolveProviderUsability(), route => {
    if (route === 'openai') {
      const seat = getGptSeatAvailability()
      return seat.state === 'ready' ? seat.ids[0] : undefined
    }
    return providerFrontierFact(route)?.modelId
  })
}

export function liveCapFailoverTarget(): CapFailoverCandidate | null {
  return liveCapFailoverCandidates().candidates[0] ?? null
}
