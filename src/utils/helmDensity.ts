
import type { ActivityState } from './cockpit/cockpitActivity.js'

export const HELM_COMPACT_ROWS = 30

export const HELM_DENSITY_FLOOR = ['seat', 'work', 'tasks', 'runs', 'mission'] as const

export type DensityEmphasis = 'identity' | 'work' | 'decision' | 'review'

export type DensityPlan = {
  activity: ActivityState
  compact: boolean
  keep: readonly string[]
  shedOrder: readonly string[]
  secondaryRows: number
  emphasis: DensityEmphasis
}

const CALM_ORDER = ['workbench', 'next', 'tabula', 'recent', 'chat', 'crew'] as const

const TABLE: Record<
  ActivityState,
  { keep: readonly string[]; shedOrder: readonly string[]; secondaryRows: number; emphasis: DensityEmphasis }
> = {
  calm: { keep: [], shedOrder: CALM_ORDER, secondaryRows: 3, emphasis: 'identity' },
  active: {
    keep: ['next'],
    shedOrder: ['workbench', 'recent', 'tabula', 'chat', 'crew'],
    secondaryRows: 1,
    emphasis: 'work',
  },
  waiting: {
    keep: [],
    shedOrder: ['workbench', 'next', 'recent', 'tabula', 'chat', 'crew'],
    secondaryRows: 0,
    emphasis: 'decision',
  },
  review: {
    keep: [],
    shedOrder: ['workbench', 'next', 'tabula', 'chat', 'crew', 'recent'],
    secondaryRows: 1,
    emphasis: 'review',
  },
}

export function densityPlan(
  activity: ActivityState,
  rows: number,
): DensityPlan {
  const row = TABLE[activity]
  const compact = rows < HELM_COMPACT_ROWS
  return {
    activity,
    compact,
    keep: row.keep,
    shedOrder: row.shedOrder,
    secondaryRows: compact ? 0 : row.secondaryRows,
    emphasis: row.emphasis,
  }
}

export function hintBudget(plan: DensityPlan): number {
  return 1 + plan.secondaryRows * 2
}
