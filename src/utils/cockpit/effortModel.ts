
export const EFFORT_AXIS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortAxisLevel = (typeof EFFORT_AXIS)[number]

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

export function describeSupercodeMode(): SupercodeModeInfo {
  return {
    pinsEffort: 'max',
    excludes: ['a co-set effort level'],
    reach: 'live',
    workflows: 'auto',
    summary: 'max reasoning + standing dynamic-orchestration · session-only · the mode owns the effort pin',
    gatedReason: '',
  }
}
