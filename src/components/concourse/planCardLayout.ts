// ============================================================================
//  planCardLayout — the manager plan card's HEIGHT BUDGET (the one pure fold
//  the card and its pins read).
//
//  The card stands inside the coordinator slot (height-bound, overflow
//  hidden) above the pane's composer. With no budget a two-lane plan at the
//  wide profile's ~38-cell text width ran ~23 rows against ~15 available:
//  the operator saw the goal and part of lane 1, then nothing — no
//  "Dispatch this plan?", no Yes/No, no legend, no composer — while the
//  Select underneath stayed live with Yes focused, so a blind ↵ dispatched
//  N sessions never read (TASK-017 supplement 3, MGR-1). The card now
//  picks the richest lane presentation that fits the rows it is handed:
//    full     title · scope · delivers · territory (each wrapped)
//    compact  title · territory (the harmony fence always shows)
//    titles   one row per lane, then a counted tail for what did not fit
//  The consent prompt and the composer are never the rows that give.
// ============================================================================

import type { ManagerLaneV1, ManagerPlanV1 } from '../../services/concourse/managerMode.js'

export type PlanLaneTier = 'full' | 'compact' | 'titles'

export interface PlanCardLayout {
  tier: PlanLaneTier
  /** Lanes painted (≥ 1 whenever the plan has a lane). */
  shown: number
  /** Lanes past the budget — named by the tail line, never silently gone. */
  hidden: number
  /** Rows the lanes block is granted (the tail line included). */
  lanesRows: number
}

/** Rows a wrapped field takes at `textWidth` — the greedy estimate the
 *  compositor's word wrap can only exceed by the odd row, which the lanes
 *  block clips inside itself (the prompt below never moves). */
const wrapRows = (text: string, textWidth: number): number =>
  Math.max(1, Math.ceil(text.length / Math.max(8, textWidth)))

export function laneRowsFor(lane: ManagerLaneV1, tier: PlanLaneTier, textWidth: number): number {
  if (tier === 'titles') return 1
  // marginTop 1 + the title row, then the indented fields (indent 2 + label).
  const body = textWidth - 2
  if (tier === 'compact') return 2 + wrapRows(`territory: ${lane.territory}`, body)
  return 2 + wrapRows(`scope: ${lane.scope}`, body) + wrapRows(`delivers: ${lane.deliverables}`, body) + wrapRows(`territory: ${lane.territory}`, body)
}

/** The card's fixed rows outside the lanes block: the dialog frame (margin,
 *  border, title), the goal, the seats line, the supervision row and the
 *  consent prompt. The prompt block is SIX rows, not four (FC-063: the old
 *  count missed its marginTop and the dialog's bottom border — at six lanes
 *  the two lost rows came out of the coordinator composer, which painted
 *  one line of five with no bottom border): marginTop 1 + question 1 +
 *  options 2 + legend 1 + bottom border 1. */
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
  // Not even one row per lane: paint what fits above a counted tail line —
  // never zero lanes, never a silent drop.
  const shown = Math.max(1, Math.min(lanes.length, budget - 1))
  const hidden = lanes.length - shown
  return { tier: 'titles', shown, hidden, lanesRows: shown + (hidden > 0 ? 1 : 0) }
}
