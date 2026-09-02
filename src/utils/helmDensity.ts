// ============================================================================
//  helmDensity — the ONE adaptive-density plan.
//
//  adaptive behaviour may make the cockpit calmer or richer, but it
//  must not achieve calmness by DELETING Mercury's cockpit. So density is not
//  "hide things when busy" — it is a re-ranking. Every panel stays; what
//  changes is which of them yields FIRST when the terminal runs out of rows,
//  and how many secondary rows a section may spend on glanceables.
//
//  The rail already sheds whole sections against a measured ceiling, in a
//  fixed order, with a fixed never-shed floor. This makes that order and that
//  floor a function of what the session is DOING — the missing half — while
//  keeping the mechanism, the ceiling and the parity proof exactly as they
//  are. One plan, consumed; no surface re-derives a threshold.
//
//  The protected classes (ruling: never hide a live warning, an active
//  decision, a failed check, a changed-file result or the selected work item)
//  are honoured structurally: the floor below always carries the mission board
//  and the work digest, and the surfaces that own warnings and decisions — the
//  permission prompt, the notification strip, the review workspace — are
//  CENTER-owned and never enter the rail's shed ladder at all.
// ============================================================================

import type { ActivityState } from './cockpit/cockpitActivity.js'

/** Below this row count the rail is compact whatever the session is doing:
 *  secondary rows are the first thing a short terminal cannot afford. The
 *  cockpit itself needs 26 rows (LAYOUT_BREAKPOINTS.cockpitMinRows), so the
 *  compact band is 26–29 — real terminals, not a hypothetical. */
export const HELM_COMPACT_ROWS = 30

/** Sections that never shed, in any mode: identity, the mission board, and an
 *  armed mission. The rail's own cursor section is added by the consumer (focus
 *  raises priority — the caret can never point at a hidden row). */
export const HELM_DENSITY_FLOOR = ['seat', 'work', 'tasks', 'runs', 'mission'] as const

/** Which region carries the strongest emphasis. The rail reads it for header
 *  tone; it exists as one vocabulary so the center and the rail cannot
 *  disagree about what the operator is being asked to look at. */
export type DensityEmphasis = 'identity' | 'work' | 'decision' | 'review'

export type DensityPlan = {
  activity: ActivityState
  /** Short terminal: no section may spend rows on secondary detail. */
  compact: boolean
  /** Sections held ABOVE the floor in this mode. */
  keep: readonly string[]
  /** Shed order, first to yield first. */
  shedOrder: readonly string[]
  /** Rows a section may spend on glanceable detail (0 = headline only). */
  secondaryRows: number
  emphasis: DensityEmphasis
}

/** The shed ladder every mode starts from — the established order. The
 *  WORKBENCH card (the ruled last-sent-prompt card under Minerva) yields
 *  FIRST in every mode: the ruling adds the card without moving anything
 *  else, so under height pressure the rail sheds exactly as it did before
 *  the card existed. */
const CALM_ORDER = ['workbench', 'next', 'tabula', 'recent', 'chat', 'crew'] as const

const TABLE: Record<
  ActivityState,
  { keep: readonly string[]; shedOrder: readonly string[]; secondaryRows: number; emphasis: DensityEmphasis }
> = {
  // Idle: the glanceables ARE the value. Established order, full budget.
  // 3 rows, not 2: the budget below turns rows into hint slots, and calm must
  // afford the WHOLE authored hint list — an idle cockpit that quietly lost
  // its last discovery row would be exactly the "emptier by accident" this
  // stage exists to prevent (and the committed baseline grids pin it).
  calm: { keep: [], shedOrder: CALM_ORDER, secondaryRows: 3, emphasis: 'identity' },
  // A turn is running: the work digest and the next action are what the
  // operator is watching, so NEXT stops being first to yield and becomes
  // protected; the ambient lanes yield in its place.
  active: {
    keep: ['next'],
    shedOrder: ['workbench', 'recent', 'tabula', 'chat', 'crew'],
    secondaryRows: 1,
    emphasis: 'work',
  },
  // A decision is pending. Everything ambient gets out of the way — including
  // the hint list, which is advice about what to do NEXT while the operator is
  // being asked about something NOW.
  waiting: {
    keep: [],
    shedOrder: ['workbench', 'next', 'recent', 'tabula', 'chat', 'crew'],
    secondaryRows: 0,
    emphasis: 'decision',
  },
  // Reviewing a result: the review surface owns the screen, the rail keeps the
  // mission board and yields the rest.
  review: {
    keep: [],
    shedOrder: ['workbench', 'next', 'tabula', 'chat', 'crew', 'recent'],
    secondaryRows: 1,
    emphasis: 'review',
  },
}

/**
 * The plan for one render. Pure: same inputs, same plan — the rail's shed
 * decision stays as deterministic as it was before density existed.
 */
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

/**
 * How many NEXT hint rows the plan affords. One is always offered — a rail
 * that shows zero next actions has stopped teaching, and "calmer" must never
 * mean "emptier by accident". The full authored list returns at calm.
 */
export function hintBudget(plan: DensityPlan): number {
  return 1 + plan.secondaryRows * 2
}
