import { flagEnv } from '../../substrate/flagRegistry.js'


export const WORK_FRAMES = ['◐', '◓', '◑', '◒'] as const
export const WORK_TICK_MS = 160

export const FOCAL_TICK_MS = 80

export const DECOR_TICK_MS = 320

export function workGlyphForTime(time: number): string {
  const idx = Math.floor(time / WORK_TICK_MS) % WORK_FRAMES.length
  return WORK_FRAMES[idx < 0 ? 0 : idx] as string
}

export const ATTENTION_PERIOD = 1800
export const ATTENTION_TICK_MS = 160
export const ATTENTION_BUCKETS = 5

export const READY_PERIOD = 3400
export const READY_TICK_MS = 160
export const READY_BUCKETS = 4

export function readyWave(time: number): number {
  const phase = ((time % READY_PERIOD) + READY_PERIOD) % READY_PERIOD
  return (Math.sin((phase / READY_PERIOD) * Math.PI * 2 - Math.PI / 2) + 1) / 2
}

export function readyBucket(time: number): number {
  return Math.round(readyWave(time) * READY_BUCKETS)
}

export const TWINKLE_CYCLE = 9200
export const TWINKLE_MS = 340
export const TWINKLE_TICK_MS = DECOR_TICK_MS

export function twinkleBright(time: number): boolean {
  const phase = ((time % TWINKLE_CYCLE) + TWINKLE_CYCLE) % TWINKLE_CYCLE
  const at = TWINKLE_CYCLE / 2
  return phase >= at && phase < at + TWINKLE_MS
}

export const SETTLE_MS = 320

export function attentionWave(time: number): number {
  const phase = ((time % ATTENTION_PERIOD) + ATTENTION_PERIOD) % ATTENTION_PERIOD
  return (Math.sin((phase / ATTENTION_PERIOD) * Math.PI * 2 - Math.PI / 2) + 1) / 2
}

export function attentionBucket(time: number): number {
  return Math.round(attentionWave(time) * ATTENTION_BUCKETS)
}

export function liveGlyphsEnabled(): boolean {
  return flagEnv('MERCURY_LIVE_GLYPHS') === '0' ? false : true
}
