
import { EFFORT_LEVELS, type EffortLevel } from '../../entrypoints/sdk/runtimeTypes.js'

export const EFFORT_AXIS: readonly EffortLevel[] = EFFORT_LEVELS
export type EffortAxisLevel = EffortLevel

export type EffortReach = 'live' | 'spawn' | 'gated'

export type EffortLevelInfo = {
  level: EffortAxisLevel
  reach: EffortReach
  note: string
}

export function describeEffortLevel(
  level: EffortAxisLevel,
  modelSupportsMax: boolean,
): EffortLevelInfo {
  switch (level) {
    case 'low':
      return { level, reach: 'live', note: 'quick, minimal-overhead reasoning' }
    case 'medium':
      return { level, reach: 'live', note: 'balanced reasoning — the common default' }
    case 'high':
      return { level, reach: 'live', note: 'comprehensive reasoning (the API default when none is sent)' }
    case 'xhigh':
      return {
        level,
        reach: 'live',
        note: 'extra-high reasoning — model-gated; a model whose vocabulary lacks it runs the nearest supported tier at dispatch',
      }
    case 'max':
      return modelSupportsMax
        ? { level, reach: 'live', note: 'maximum reasoning — supported on this model; session-only' }
        : {
            level,
            reach: 'live',
            note: 'accepted as standing intent — this model runs its deepest supported tier (the control states the applied value)',
          }
  }
}


export type SupercodeModeInfo = {
  pinsEffort: 'max'
  excludes: readonly string[]
  reach: EffortReach
  workflows: 'auto'
  summary: string
  gatedReason: string
}

export const DELEGATION_LEAD_NOTE = "the provider's list marks this row as able to lead delegation"

export function describeSupercodeMode(facts: { providerMarksDelegationLead?: boolean } = {}): SupercodeModeInfo {
  const lead = facts.providerMarksDelegationLead === true ? ` · ${DELEGATION_LEAD_NOTE}` : ''
  return {
    pinsEffort: 'max',
    excludes: ['a co-set effort level'],
    reach: 'live',
    workflows: 'auto',
    summary: `max reasoning + proactive delegation where parallel agents help · session-only · the mode owns the effort pin${lead}`,
    gatedReason: '',
  }
}
