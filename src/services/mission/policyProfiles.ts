
import { createHash } from 'node:crypto'
import { OUTCOME_MAX_WEIGHT, OUTCOME_MIN_SAMPLES } from '../../utils/router/routeCompiler.js'
import type { RouteTaskShape } from '../../utils/router/contracts.js'

export const MISSION_PROFILE_IDS = [
  'solo-default',
  'solo-reviewer',
  'routed-lite',
  'routed-wide',
  'specialist-sol',
  'workflow-deep',
] as const
export type MissionProfileId = (typeof MISSION_PROFILE_IDS)[number]

export interface MissionPolicyProfile {
  id: MissionProfileId
  description: string
  execution: 'solo' | 'routed' | 'workflow'
  plannerClass: 'opus'
  executorClass: 'opus' | 'sonnet' | 'gpt'
  effort: 'high' | 'xhigh'
  maxWidth: 1 | 2 | 3
  capsuleProfile: 'standard' | 'lean'
  memoryRefCount: number
  reviewerCadence: 'none' | 'on-completion'
  retryProfile: 'standard' | 'trap-aware'
}

export const MISSION_PROFILES: readonly MissionPolicyProfile[] = [
  {
    id: 'solo-default',
    description: 'one strong-model run — the current accepted default',
    execution: 'solo',
    plannerClass: 'opus',
    executorClass: 'opus',
    effort: 'high',
    maxWidth: 1,
    capsuleProfile: 'standard',
    memoryRefCount: 6,
    reviewerCadence: 'none',
    retryProfile: 'standard',
  },
  {
    id: 'solo-reviewer',
    description: 'solo plus the verification red-team subagent before completion',
    execution: 'solo',
    plannerClass: 'opus',
    executorClass: 'opus',
    effort: 'high',
    maxWidth: 1,
    capsuleProfile: 'standard',
    memoryRefCount: 6,
    reviewerCadence: 'on-completion',
    retryProfile: 'standard',
  },
  {
    id: 'routed-lite',
    description: 'two disjoint executor lanes under the route fabric',
    execution: 'routed',
    plannerClass: 'opus',
    executorClass: 'sonnet',
    effort: 'high',
    maxWidth: 2,
    capsuleProfile: 'standard',
    memoryRefCount: 6,
    reviewerCadence: 'on-completion',
    retryProfile: 'standard',
  },
  {
    id: 'routed-wide',
    description: 'three disjoint executor lanes under the route fabric',
    execution: 'routed',
    plannerClass: 'opus',
    executorClass: 'sonnet',
    effort: 'high',
    maxWidth: 3,
    capsuleProfile: 'standard',
    memoryRefCount: 6,
    reviewerCadence: 'on-completion',
    retryProfile: 'standard',
  },
  {
    id: 'specialist-sol',
    description: 'the qualified GPT lane for bounded mechanical work (subscription, ≤1 Sol)',
    execution: 'solo',
    plannerClass: 'opus',
    executorClass: 'gpt',
    effort: 'high',
    maxWidth: 1,
    capsuleProfile: 'lean',
    memoryRefCount: 3,
    reviewerCadence: 'none',
    retryProfile: 'standard',
  },
  {
    id: 'workflow-deep',
    description: 'Workflow-engine composition for long tool-heavy separable work',
    execution: 'workflow',
    plannerClass: 'opus',
    executorClass: 'sonnet',
    effort: 'high',
    maxWidth: 3,
    capsuleProfile: 'standard',
    memoryRefCount: 6,
    reviewerCadence: 'on-completion',
    retryProfile: 'trap-aware',
  },
]

export function missionProfileById(id: string): MissionPolicyProfile | null {
  return MISSION_PROFILES.find(p => p.id === id) ?? null
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function missionProfileDigest(profile: MissionPolicyProfile): string {
  return 'mp1-' + createHash('sha256').update(stableStringify(profile)).digest('hex').slice(0, 16)
}

export function missionProfileSetDigest(): string {
  return 'mps1-' + createHash('sha256').update(stableStringify(MISSION_PROFILES)).digest('hex').slice(0, 16)
}

export function missionPolicyEpoch(inputs: { architectureEpoch: string; frontierDefaultModel: string }): string {
  return (
    'pe1-' +
    createHash('sha256')
      .update(inputs.architectureEpoch + '|' + inputs.frontierDefaultModel + '|' + missionProfileSetDigest())
      .digest('hex')
      .slice(0, 16)
  )
}


export interface MissionTaskFingerprint {
  shape: RouteTaskShape
  separableLanes: number
  couplingBand: 0 | 1 | 2 | 3
  ambiguityBand: 0 | 1 | 2 | 3
  mechanical: boolean
  investigation: boolean
}

export const MISSION_POLICY_REASONS = [
  'pin-wins',
  'investigation-shape',
  'mechanical-shape',
  'separable-lanes',
  'coupling-serializes',
  'ambiguity-strong-planner',
  'workflow-long-horizon',
  'solo-fit',
  'history-adjusted-reviewer',
  'history-low-sample-ignored',
  'history-epoch-mismatch-ignored',
  'engine-unqualified-fallback',
  'width-capped-by-separability',
  'insufficient-confidence-fallback',
] as const
export type MissionPolicyReason = (typeof MISSION_POLICY_REASONS)[number]

export interface MissionHistoryStats {
  profileId: MissionProfileId
  epoch: string
  sampleCount: number
  acceptedRate: number
}

export interface MissionPolicyDecision {
  profile: MissionPolicyProfile
  profileDigest: string
  source: 'operator-pin' | 'task-facts' | 'history-adjusted' | 'fallback'
  reasonCodes: MissionPolicyReason[]
  epoch: string
  history?: { sampleCount: number; acceptedRate: number; weight: number }
  declined: { profileId: string; reason: MissionPolicyReason }[]
}

export interface MissionPolicyInputs {
  fingerprint: MissionTaskFingerprint
  epoch: string
  pin: string | null
  solEngineQualified: boolean
  history: MissionHistoryStats[]
}

export function selectMissionPolicy(inputs: MissionPolicyInputs): MissionPolicyDecision {
  const { fingerprint: fp, epoch } = inputs
  const declined: MissionPolicyDecision['declined'] = []
  const decide = (
    id: MissionProfileId,
    source: MissionPolicyDecision['source'],
    reasonCodes: MissionPolicyReason[],
    history?: MissionPolicyDecision['history'],
  ): MissionPolicyDecision => {
    const profile = missionProfileById(id)
    if (!profile) throw new Error('unknown mission profile: ' + id)
    return { profile, profileDigest: missionProfileDigest(profile), source, reasonCodes, epoch, declined, ...(history ? { history } : {}) }
  }

  if (inputs.pin !== null) {
    const pinned = missionProfileById(inputs.pin)
    if (pinned) {
      if (pinned.executorClass === 'gpt' && !inputs.solEngineQualified) {
        declined.push({ profileId: pinned.id, reason: 'engine-unqualified-fallback' })
        return decide('solo-default', 'fallback', ['pin-wins', 'engine-unqualified-fallback'])
      }
      return decide(pinned.id, 'operator-pin', ['pin-wins'])
    }
  }

  if (fp.mechanical && fp.ambiguityBand >= 2) {
    return decide('solo-default', 'fallback', ['insufficient-confidence-fallback'])
  }

  let baseId: MissionProfileId
  const reasons: MissionPolicyReason[] = []
  if (fp.investigation) {
    baseId = 'solo-default'
    reasons.push('investigation-shape')
  } else if (fp.mechanical) {
    if (inputs.solEngineQualified) {
      baseId = 'specialist-sol'
      reasons.push('mechanical-shape')
    } else {
      declined.push({ profileId: 'specialist-sol', reason: 'engine-unqualified-fallback' })
      baseId = 'solo-default'
      reasons.push('mechanical-shape', 'engine-unqualified-fallback')
    }
  } else if (fp.shape === 'cross-cutting' && fp.separableLanes >= 2 && fp.couplingBand <= 1) {
    baseId = 'workflow-deep'
    reasons.push('workflow-long-horizon', 'separable-lanes')
  } else if (fp.separableLanes >= 2 && fp.couplingBand >= 2) {
    baseId = 'solo-default'
    reasons.push('coupling-serializes')
  } else if (fp.separableLanes >= 3 && fp.couplingBand <= 1) {
    baseId = 'routed-wide'
    reasons.push('separable-lanes')
  } else if (fp.separableLanes === 2 && fp.couplingBand <= 1) {
    baseId = 'routed-lite'
    reasons.push('separable-lanes', 'width-capped-by-separability')
  } else if (fp.ambiguityBand >= 2) {
    baseId = 'solo-default'
    reasons.push('ambiguity-strong-planner')
  } else {
    baseId = 'solo-default'
    reasons.push('solo-fit')
  }

  const stats = inputs.history.find(h => h.profileId === baseId)
  if (stats) {
    if (stats.epoch !== epoch) {
      reasons.push('history-epoch-mismatch-ignored')
    } else if (stats.sampleCount < OUTCOME_MIN_SAMPLES) {
      reasons.push('history-low-sample-ignored')
    } else if (baseId === 'solo-default' && stats.acceptedRate < 0.5) {
      return decide('solo-reviewer', 'history-adjusted', [...reasons, 'history-adjusted-reviewer'], {
        sampleCount: stats.sampleCount,
        acceptedRate: stats.acceptedRate,
        weight: OUTCOME_MAX_WEIGHT,
      })
    }
  }

  return decide(baseId, 'task-facts', reasons)
}
