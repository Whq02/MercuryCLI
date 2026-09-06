import { flagEnv } from '../../substrate/flagRegistry.js'
import { SLEEP_PHASES, SWAY_PHASES } from './critterData.js'


export const EYE_OPEN = '●'
export const EYE_SHUT = '—'

export const BLINK_CYCLE = 5200
export const LID_MS = 150
export const SECOND_LID_AT = 280
export const BREATH_PERIOD = 2800
export const IDLE_TICK_MS = 80
export const BREATH_TICK_MS = 120

export function critterIdleEnabled(): boolean {
  return flagEnv('MERCURY_CRITTER_IDLE') === '0' ? false : true
}

export function critterIdleTickMs(level: 'full' | 'reduced' | 'off', asleep: boolean): number | null {
  if (level !== 'full') return null
  return asleep ? SLEEP_TICK_MS : IDLE_TICK_MS
}

export function pupilForTime(time: number): string {
  const phase = time % BLINK_CYCLE
  const doubleBlink = Math.floor(time / BLINK_CYCLE) % 4 === 3
  const shut =
    phase < LID_MS || (doubleBlink && phase >= SECOND_LID_AT && phase < SECOND_LID_AT + LID_MS)
  return shut ? EYE_SHUT : EYE_OPEN
}


export const SWAY_TICK_MS = 700

export const SLEEP_SWAY_TICK_MS = SWAY_TICK_MS * 3

export const SLEEP_TICK_MS = 900


export type SwayAnchor = { phase: number; at: number }

export const ZERO_SWAY_ANCHOR: SwayAnchor = { phase: 0, at: 0 }

export function swayPhaseAt(
  time: number,
  asleep: boolean,
  anchor: SwayAnchor = ZERO_SWAY_ANCHOR,
): number {
  const tick = asleep ? SLEEP_SWAY_TICK_MS : SWAY_TICK_MS
  const steps = Math.floor(Math.max(0, time - anchor.at) / tick)
  return (((anchor.phase + steps) % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES
}

export function critterFrameKey(
  time: number,
  asleep: boolean,
  anchor: SwayAnchor = ZERO_SWAY_ANCHOR,
  sleepSince = 0,
): string {
  const sway = swayPhaseAt(time, asleep, anchor)
  if (asleep) {
    const zzz =
      Math.floor(Math.max(0, time - sleepSince) / SLEEP_TICK_MS) % SLEEP_PHASES
    return `${EYE_SHUT}${sway}${zzz}`
  }
  return `${pupilForTime(time)}${sway}-`
}

export function readCritterFrameKey(key: string): {
  pupil: string
  swayPhase: number
  sleepPhase: number | null
} {
  const pupil = key[0] ?? EYE_OPEN
  const sway = Number.parseInt(key[1] ?? '0', 10)
  const zc = key[2] ?? '-'
  const zzz = zc === '-' ? null : Number.parseInt(zc, 10)
  return {
    pupil,
    swayPhase: Number.isFinite(sway) ? sway : 0,
    sleepPhase: zzz !== null && Number.isFinite(zzz) ? zzz : null,
  }
}

export function breathWave(time: number): number {
  const phase = (time % BREATH_PERIOD) / BREATH_PERIOD
  return (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2
}

export const BREATH_BUCKETS = 6
export function breathBucket(time: number): number {
  return Math.round(breathWave(time) * BREATH_BUCKETS)
}
