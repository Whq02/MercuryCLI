
import type { ManagerLaneV1, ManagerPlanV1 } from '../../services/concourse/managerMode.js'

export type PlanLaneTier = 'full' | 'compact' | 'titles'

export interface PlanCardLayout {
  tier: PlanLaneTier
  shown: number
  hidden: number
  lanesRows: number
}

const wrapRows = (text: string, textWidth: number): number =>
  Math.max(1, Math.ceil(text.length / Math.max(8, textWidth)))

export function laneRowsFor(lane: ManagerLaneV1, tier: PlanLaneTier, textWidth: number): number {
  if (tier === 'titles') return 1
  const body = textWidth - 2
  if (tier === 'compact') return 2 + wrapRows(`territory: ${lane.territory}`, body)
  return 2 + wrapRows(`scope: ${lane.scope}`, body) + wrapRows(`delivers: ${lane.deliverables}`, body) + wrapRows(`territory: ${lane.territory}`, body)
}

export function planCardFixedRows(plan: ManagerPlanV1, textWidth: number): number {
  return 3 + wrapRows(plan.goal, textWidth) + (plan.seats !== undefined ? 1 : 0) + 2 + 6
}

export function planCardLayout(plan: ManagerPlanV1, maxRows: number | undefined, textWidth: number): PlanCardLayout {
  const lanes = plan.lanes
  const fullRows = lanes.reduce((n, l) => n + laneRowsFor(l, 'full', textWidth), 0)
  if (maxRows === undefined || !Number.isFinite(maxRows)) {
    return { tier: 'full', shown: lanes.length, hidden: 0, lanesRows: fullRows }
  }
  const budget = Math.max(1, maxRows - planCardFixedRows(plan, textWidth))
  for (const tier of ['full', 'compact'] as const) {
    const rows = lanes.reduce((n, l) => n + laneRowsFor(l, tier, textWidth), 0)
    if (rows <= budget) return { tier, shown: lanes.length, hidden: 0, lanesRows: rows }
  }
  if (lanes.length <= budget) return { tier: 'titles', shown: lanes.length, hidden: 0, lanesRows: lanes.length }
  const shown = Math.max(1, Math.min(lanes.length, budget - 1))
  const hidden = lanes.length - shown
  return { tier: 'titles', shown, hidden, lanesRows: shown + (hidden > 0 ? 1 : 0) }
}
