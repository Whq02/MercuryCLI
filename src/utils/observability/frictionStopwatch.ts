// ============================================================================
//  frictionStopwatch — time-to-interactive instrumentation for the major
//  transitions. Pure + React-free.
//
//  Felt quality is part of correctness (law 4): the moments the operator
//  WAITS — boot to the first interactive prompt, a command-center screen
//  switch, the model picker opening — get measured against NAMED budgets,
//  and the measurement surface (/trace FRICTION section) renders a budget
//  regression red. The budgets are product intent (tunable numbers); every
//  prover pins the MECHANISMS (classification, matching, bounds), never
//  today's numbers (law 5).
//
//  Measurement law: every sample is a REAL observed duration —
//    · boot-interactive: process.uptime() at the REPL's first interactive
//      mount (the same base the ink-root mount log uses);
//    · screen transitions: an explicit start mark at the dispatch seam and
//      an end mark at the surface's mount. An end without a pending start
//      records nothing (never an invented duration); a start that never
//      ends records nothing (an abandoned dispatch is not a transition).
//  Bounded ring per transition; module state, session lifetime.
// ============================================================================

export type FrictionTransition = 'boot-interactive' | 'screen-switch' | 'picker-open'

/** The NAMED budgets, in ms — product intent for "feels immediate", one per
 *  transition. Tuning a budget is a product decision; the classification
 *  mechanism (over = sample > budget) is the invariant the provers pin. */
export const FRICTION_BUDGETS_MS: Record<FrictionTransition, number> = {
  'boot-interactive': 4_000,
  'screen-switch': 250,
  'picker-open': 250,
}

const MAX_SAMPLES = 50

interface TransitionSlot {
  samples: number[]
  pendingStartMs: number | null
}

function freshSlot(): TransitionSlot {
  return { samples: [], pendingStartMs: null }
}

const slots: Record<FrictionTransition, TransitionSlot> = {
  'boot-interactive': freshSlot(),
  'screen-switch': freshSlot(),
  'picker-open': freshSlot(),
}

let bootRecorded = false

function pushSample(slot: TransitionSlot, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  slot.samples.push(ms)
  if (slot.samples.length > MAX_SAMPLES) {
    slot.samples.splice(0, slot.samples.length - MAX_SAMPLES)
  }
}

/** Record boot→interactive ONCE, from the process's own uptime (the REPL's
 *  first interactive mount calls this; later calls no-op — a /clear is not
 *  a boot). */
export function recordBootInteractive(nowUptimeMs: number = process.uptime() * 1000): void {
  if (bootRecorded) return
  bootRecorded = true
  pushSample(slots['boot-interactive'], Math.round(nowUptimeMs))
}

/** Mark a transition's start at its dispatch seam (latest start wins). */
export function markTransitionStart(
  name: Exclude<FrictionTransition, 'boot-interactive'>,
  atMs: number = Date.now(),
): void {
  slots[name].pendingStartMs = atMs
}

/** Mark the transition's end at the surface's mount. No pending start ⇒
 *  records nothing (never an invented duration). */
export function markTransitionEnd(
  name: Exclude<FrictionTransition, 'boot-interactive'>,
  atMs: number = Date.now(),
): void {
  const slot = slots[name]
  if (slot.pendingStartMs === null) return
  pushSample(slot, atMs - slot.pendingStartMs)
  slot.pendingStartMs = null
}

export interface FrictionRow {
  transition: FrictionTransition
  budgetMs: number
  /** Most recent observed duration; null when nothing measured yet. */
  lastMs: number | null
  /** Worst observed duration this session; null when nothing measured. */
  worstMs: number | null
  samples: number
  /** The regression fact the surface renders red: the LAST observation
   *  exceeded the named budget. */
  over: boolean
}

/** The one derivation every friction renderer reads. */
export function frictionSnapshot(): FrictionRow[] {
  return (Object.keys(slots) as FrictionTransition[]).map(transition => {
    const slot = slots[transition]
    const last = slot.samples.length > 0 ? slot.samples[slot.samples.length - 1]! : null
    const worst = slot.samples.length > 0 ? Math.max(...slot.samples) : null
    const budgetMs = FRICTION_BUDGETS_MS[transition]
    return {
      transition,
      budgetMs,
      lastMs: last,
      worstMs: worst,
      samples: slot.samples.length,
      over: last !== null && last > budgetMs,
    }
  })
}

/** Test seam. */
export function __resetFrictionStopwatchForTest(): void {
  for (const key of Object.keys(slots) as FrictionTransition[]) {
    slots[key] = freshSlot()
  }
  bootRecorded = false
}
