import { performance as perf } from 'node:perf_hooks'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { FRAME_INTERVAL_MS } from '../../ink/constants.js'
import { critterIdleEnabled } from './critterIdle.js'
import { liveGlyphsEnabled, REDUCED_TICK_MS } from './liveGlyphs.js'
import { getTerminalFocused, subscribeTerminalFocus } from '../../ink/session/focus-store.js'
import { companionTurnSignals, subscribeCompanionSignals } from './companionSignals.js'

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
export type MotionRestState = 'awake' | 'quiet' | 'blurred'
export const MOTION_QUIET_AFTER_MS = 5000

export type MotionRestTimers = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

const REAL_REST_TIMERS: MotionRestTimers = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

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
  overRun: number
  overCostMs: number
  underRun: number
  reducedPeriodMs: number
  framesSeen: number
  meter: LoopMeter
  listeners: Set<() => void>
  quiet: boolean
  focused: boolean
  busy: boolean
  restTimer: unknown
  restTimers: MotionRestTimers
  stopRestObservation: (() => void) | null
}

const S: GovernorState = ((globalThis as Record<string, unknown>).__mercuryMotionGovernor ??= {
  posture: 'auto',
  level: 'full',
  overRun: 0,
  overCostMs: 0,
  underRun: 0,
  reducedPeriodMs: REDUCED_FLOOR_MS,
  framesSeen: 0,
  meter: REAL_LOOP_METER,
  listeners: new Set(),
  quiet: false,
  focused: true,
  busy: false,
  restTimer: null,
  restTimers: REAL_REST_TIMERS,
  stopRestObservation: null,
}) as GovernorState

function turnIsActive(): boolean {
  const signals = companionTurnSignals()
  return signals.turnLive || signals.streaming || signals.awaitingPermission
}

function armRestTimer(): void {
  if (S.restTimer !== null) S.restTimers.clearTimeout(S.restTimer)
  S.restTimer = null
  if (S.stopRestObservation === null || S.busy || !S.focused) return
  S.restTimer = S.restTimers.setTimeout(() => {
    S.restTimer = null
    if (S.busy || !S.focused) return
    S.quiet = true
    notify()
  }, MOTION_QUIET_AFTER_MS)
}

function observeRest(): void {
  if (S.stopRestObservation !== null) return
  S.focused = getTerminalFocused()
  S.busy = turnIsActive()
  S.quiet = false
  const stopFocus = subscribeTerminalFocus(() => {
    const focused = getTerminalFocused()
    if (focused === S.focused) return
    S.focused = focused
    if (focused) S.quiet = false
    armRestTimer()
    notify()
  })
  const stopTurn = subscribeCompanionSignals(() => {
    const busy = turnIsActive()
    if (busy === S.busy) return
    S.busy = busy
    S.quiet = false
    armRestTimer()
    notify()
  })
  S.stopRestObservation = () => {
    stopFocus()
    stopTurn()
    if (S.restTimer !== null) S.restTimers.clearTimeout(S.restTimer)
    S.restTimer = null
    S.stopRestObservation = null
    S.quiet = false
  }
  armRestTimer()
}

export function noteMotionInput(): void {
  const changed = S.quiet
  S.quiet = false
  armRestTimer()
  if (changed) notify()
}

export function motionRestState(): MotionRestState {
  if (S.busy) return 'awake'
  if (!S.focused) return 'blurred'
  return S.quiet ? 'quiet' : 'awake'
}

export function restMotionPaused(): boolean {
  return S.posture !== 'full' && motionRestState() !== 'awake'
}

function notify(): void {
  for (const fn of S.listeners) fn()
}

export function subscribeIdleMotion(fn: () => void): () => void {
  S.listeners.add(fn)
  observeRest()
  return () => {
    S.listeners.delete(fn)
    if (S.listeners.size === 0) S.stopRestObservation?.()
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

export function reducedPeriodMs(): number {
  return S.reducedPeriodMs
}

export function noteFrameCost(costMs: number): void {
  if (!Number.isFinite(costMs) || costMs < 0) return
  S.framesSeen++
  if (S.level === 'full') {
    if (costMs > FRAME_BUDGET_MS) {
      if (S.overRun === 0) S.meter.begin()
      S.overRun++
      S.overCostMs += costMs
      if (S.overRun >= TRIP_RUN && S.overCostMs >= TRIP_RUN_COST_MS) {
        S.overRun = 0
        S.overCostMs = 0
        const busy = S.meter.busyShare()
        if (busy === null || busy >= LOOP_BUSY_SHARE) {
          S.level = 'reduced'
          S.underRun = 0
          S.reducedPeriodMs = REDUCED_FLOOR_MS
          notify()
        }
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
  if (costMs <= FRAME_BUDGET_MS) {
    S.underRun++
    if (S.underRun >= RELEASE_RUN) {
      S.level = 'full'
      S.underRun = 0
      S.overRun = 0
      S.overCostMs = 0
      S.reducedPeriodMs = REDUCED_FLOOR_MS
      notify()
    }
  } else {
    S.underRun = 0
  }
}


function postureLevel(): IdleMotionLevel {
  return S.posture === 'auto' ? S.level : S.posture
}

export function settledMotionLevel(part: IdleMotionPart): IdleMotionLevel {
  const base = postureLevel()
  const critter = critterIdleEnabled() ? base : 'off'
  const glyphs = liveGlyphsEnabled() ? base : 'off'
  if (part === 'critter') return critter
  if (part === 'glyphs') return glyphs
  return critter === 'off' && glyphs === 'off' ? 'off' : base
}

export function idleMotionWord(): 'reduced' | null {
  return settledMotionLevel('clock') === 'reduced' ? 'reduced' : null
}

export function idleMotionLevel(part: IdleMotionPart): IdleMotionLevel {
  const level = settledMotionLevel(part)
  if (level === 'off' || S.posture === 'full') return level
  const rest = motionRestState()
  if (rest === 'blurred') return 'off'
  return rest === 'quiet' ? 'reduced' : level
}

export function clockPeriodMs(baseMs: number): number {
  const level = idleMotionLevel('clock')
  if (S.posture !== 'off' && S.posture !== 'full' && motionRestState() === 'blurred') return 0
  return level === 'reduced' ? Math.max(baseMs, S.reducedPeriodMs) : baseMs
}

export function motionGovernorFacts(): {
  posture: MotionPosture
  level: GovernorLevel
  effective: IdleMotionLevel
  reducedPeriodMs: number
  framesSeen: number
  rest: MotionRestState
} {
  return {
    posture: S.posture,
    level: S.level,
    effective: settledMotionLevel('clock'),
    rest: motionRestState(),
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
  S.overRun = 0
  S.overCostMs = 0
  S.underRun = 0
  S.reducedPeriodMs = REDUCED_FLOOR_MS
  S.framesSeen = 0
  S.quiet = false
  S.focused = getTerminalFocused()
  S.busy = turnIsActive()
  armRestTimer()
}

export function __setMotionRestTimersForTest(timers: MotionRestTimers | null): void {
  if (S.restTimer !== null) S.restTimers.clearTimeout(S.restTimer)
  S.restTimer = null
  S.restTimers = timers ?? REAL_REST_TIMERS
  S.quiet = false
  armRestTimer()
}
