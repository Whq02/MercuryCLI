const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LADDER)[number]
export const EFFORT_LEVELS: readonly EffortLevel[] = EFFORT_LADDER
