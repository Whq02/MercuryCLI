import { performance as perf } from 'node:perf_hooks'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { FRAME_INTERVAL_MS } from '../../ink/constants.js'
import { critterIdleEnabled } from './critterIdle.js'
import { liveGlyphsEnabled, REDUCED_TICK_MS } from './liveGlyphs.js'

export const FRAME_BUDGET_MS = FRAME_INTERVAL_MS
export const TRIP_RUN = 12
export const TRIP_RUN_COST_MS = 600
export const RELEASE_RUN = 48
export const LOOP_BUSY_SHARE = 0.5
export const REDUCED_FLOOR_MS = REDUCED_TICK_MS
export const REDUCED_CEILING_MS = 2000

export type MotionPosture = 'auto' | 'full' | 'reduced' | 'off'
export type IdleMotionLevel = 'full' | 'reduced' | 'off'
export type IdleMotionPart = 'critter' | 'glyphs' | 'clock'
export type GovernorLevel = 'full' | 'reduced'
export type GovernorTrip = 'paint' | 'wire'

export type FrameWireNote = { seq: number; wireBytes: number; drainMs: number | null }

export interface LoopMeter {
  begin(): void
  busyShare(): number | null
}

type LoopUtilization = { utilization: number }
type PerfWithLoop = { eventLoopUtilization?: (since?: LoopUtilization) => LoopUtilization }

const REAL_LOOP_METER: LoopMeter = (() => {
  let mark: LoopUtilization | null = null
  const p = perf as unknown as PerfWithLoop
  return {
    begin() {
      mark = typeof p.eventLoopUtilization === 'function' ? p.eventLoopUtilization() : null
    },
    busyShare() {
      if (mark === null || typeof p.eventLoopUtilization !== 'function') return null
      const share = p.eventLoopUtilization(mark).utilization
      return Number.isFinite(share) ? share : null
    },
  }
})()

type GovernorState = {
  posture: MotionPosture
  level: GovernorLevel
  trip: GovernorTrip | null
  overRun: number
  overCostMs: number
  drainRun: number
  drainRunMs: number
  frameDrainMs: number | null
  wireSeq: number
  underRun: number
  reducedPeriodMs: number
  framesSeen: number
  meter: LoopMeter
  listeners: Set<() => void>
}

const S: GovernorState = ((globalThis as Record<string, unknown>).__mercuryMotionGovernor ??= {
  posture: 'auto',
  level: 'full',
  trip: null,
  overRun: 0,
  overCostMs: 0,
  drainRun: 0,
  drainRunMs: 0,
  frameDrainMs: null,
  wireSeq: -1,
  underRun: 0,
  reducedPeriodMs: REDUCED_FLOOR_MS,
  framesSeen: 0,
  meter: REAL_LOOP_METER,
  listeners: new Set(),
}) as GovernorState

function notify(): void {
  for (const fn of S.listeners) fn()
}

export function subscribeIdleMotion(fn: () => void): () => void {
  S.listeners.add(fn)
  return () => {
    S.listeners.delete(fn)
  }
}


export function motionPosture(): MotionPosture {
  return S.posture
}

export function setMotionPosture(posture: MotionPosture, options: { quiet?: boolean } = {}): void {
  if (S.posture === posture) return
  S.posture = posture
  if (!options.quiet) notify()
}


export function governorLevel(): GovernorLevel {
  return S.level
}

export function governorTrip(): GovernorTrip | null {
  return S.trip
}

export function reducedPeriodMs(): number {
  return S.reducedPeriodMs
}

function clearRuns(): void {
  S.overRun = 0
  S.overCostMs = 0
  S.drainRun = 0
  S.drainRunMs = 0
  S.underRun = 0
}

function tripTo(reason: GovernorTrip): void {
  clearRuns()
  S.level = 'reduced'
  S.trip = reason
  S.reducedPeriodMs = REDUCED_FLOOR_MS
  notify()
}

function release(): void {
  clearRuns()
  S.level = 'full'
  S.trip = null
  S.reducedPeriodMs = REDUCED_FLOOR_MS
  notify()
}

export function noteFrameWire(wire: FrameWireNote | null): void {
  if (wire === null || wire.seq === S.wireSeq) return
  S.wireSeq = wire.seq
  const drain = wire.drainMs
  S.frameDrainMs = drain !== null && Number.isFinite(drain) && drain >= 0 ? drain : null
}

export function noteFrameCost(costMs: number): void {
  if (!Number.isFinite(costMs) || costMs < 0) return
  const drainMs = S.frameDrainMs
  S.frameDrainMs = null
  S.framesSeen++
  if (S.level === 'full') {
    if (drainMs !== null) {
      if (drainMs > FRAME_BUDGET_MS) {
        S.drainRun++
        S.drainRunMs += drainMs
        if (S.drainRun >= TRIP_RUN && S.drainRunMs >= TRIP_RUN_COST_MS) {
          tripTo('wire')
          return
        }
      } else {
        S.drainRun = 0
        S.drainRunMs = 0
      }
    }
    if (costMs > FRAME_BUDGET_MS) {
      if (S.overRun === 0) S.meter.begin()
      S.overRun++
      S.overCostMs += costMs
      if (S.overRun >= TRIP_RUN && S.overCostMs >= TRIP_RUN_COST_MS) {
        S.overRun = 0
        S.overCostMs = 0
        const busy = S.meter.busyShare()
        if (busy === null || busy >= LOOP_BUSY_SHARE) tripTo('paint')
      }
    } else {
      S.overRun = 0
      S.overCostMs = 0
    }
    return
  }
  let period = S.reducedPeriodMs
  if (costMs > period) period = Math.min(REDUCED_CEILING_MS, period * 2)
  else if (costMs * 4 < period) period = Math.max(REDUCED_FLOOR_MS, period / 2)
  if (period !== S.reducedPeriodMs) {
    S.reducedPeriodMs = period
    notify()
  }
  if (costMs <= FRAME_BUDGET_MS && (drainMs === null || drainMs <= FRAME_BUDGET_MS)) {
    S.underRun++
    if (S.underRun >= RELEASE_RUN) release()
  } else {
    S.underRun = 0
  }
}


function postureLevel(): IdleMotionLevel {
  return S.posture === 'auto' ? S.level : S.posture
}

export function idleMotionLevel(part: IdleMotionPart): IdleMotionLevel {
  const base = postureLevel()
  const critter = critterIdleEnabled() ? base : 'off'
  const glyphs = liveGlyphsEnabled() ? base : 'off'
  if (part === 'critter') return critter
  if (part === 'glyphs') return glyphs
  return critter === 'off' && glyphs === 'off' ? 'off' : base
}

export function idleMotionWord(): 'reduced' | null {
  return idleMotionLevel('clock') === 'reduced' ? 'reduced' : null
}

export function clockPeriodMs(baseMs: number): number {
  return idleMotionLevel('clock') === 'reduced' ? Math.max(baseMs, S.reducedPeriodMs) : baseMs
}

export function motionGovernorFacts(): {
  posture: MotionPosture
  level: GovernorLevel
  trip: GovernorTrip | null
  effective: IdleMotionLevel
  reducedPeriodMs: number
  framesSeen: number
} {
  return {
    posture: S.posture,
    level: S.level,
    trip: S.trip,
    effective: idleMotionLevel('clock'),
    reducedPeriodMs: S.reducedPeriodMs,
    framesSeen: S.framesSeen,
  }
}


let padMs: number | null = null

export function burnFrameCostPad(): void {
  if (padMs === null) {
    const raw = Number(flagEnv('MERCURY_FRAME_COST_PAD_MS') ?? '0')
    padMs = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 0
  }
  if (padMs === 0) return
  const until = perf.now() + padMs
  while (perf.now() < until) {
  }
}


export function __setLoopMeterForTest(meter: LoopMeter | null): void {
  S.meter = meter ?? REAL_LOOP_METER
}

export function __motionGovernorResetForTest(): void {
  S.posture = 'auto'
  S.level = 'full'
  S.trip = null
  clearRuns()
  S.frameDrainMs = null
  S.wireSeq = -1
  S.reducedPeriodMs = REDUCED_FLOOR_MS
  S.framesSeen = 0
}
