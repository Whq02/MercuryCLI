
export type FrictionTransition = 'boot-interactive' | 'screen-switch' | 'picker-open'

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

export function recordBootInteractive(nowUptimeMs: number = process.uptime() * 1000): void {
  if (bootRecorded) return
  bootRecorded = true
  pushSample(slots['boot-interactive'], Math.round(nowUptimeMs))
}

export function markTransitionStart(
  name: Exclude<FrictionTransition, 'boot-interactive'>,
  atMs: number = Date.now(),
): void {
  slots[name].pendingStartMs = atMs
}

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
  lastMs: number | null
  worstMs: number | null
  samples: number
  over: boolean
}

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

export function __resetFrictionStopwatchForTest(): void {
  for (const key of Object.keys(slots) as FrictionTransition[]) {
    slots[key] = freshSlot()
  }
  bootRecorded = false
}
