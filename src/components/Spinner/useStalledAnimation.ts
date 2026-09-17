import { useRef } from 'react'
import type { SpinnerMode } from './types.js'


export const MID_STREAM_STILL_WAITING_MS = 10_000

export const STILL_WAITING_MAX_INTENSITY = 0.5

export type StallViewInput = {
  mode: SpinnerMode
  suppressed: boolean
  lastEventAt: number | null
  now: number
}

export type StallView = {
  stillWaiting: boolean
  targetIntensity: number
}

export function computeStallView(a: StallViewInput): StallView {
  const calm: StallView = { stillWaiting: false, targetIntensity: 0 }
  if (a.suppressed) return calm
  if (a.mode !== 'responding') return calm
  if (a.lastEventAt === null) return calm
  const gap = a.now - a.lastEventAt
  if (gap < MID_STREAM_STILL_WAITING_MS) return calm
  return { stillWaiting: true, targetIntensity: STILL_WAITING_MAX_INTENSITY }
}

export function easeAttention(
  current: number,
  target: number,
  dtMs: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return target
  if (dtMs <= 0) return current
  const steps = Math.floor(dtMs / 50)
  let value = current
  for (let i = 0; i < steps; i++) {
    const diff = target - value
    if (Math.abs(diff) < 0.01) return target
    value += diff * 0.1
  }
  return value
}

export type StalledAnimationArgs = {
  mode: SpinnerMode
  currentResponseLength: number
  suppressed: boolean
  reducedMotion: boolean
}

export function useStalledAnimation(
  time: number,
  {
    mode,
    currentResponseLength,
    suppressed,
    reducedMotion,
  }: StalledAnimationArgs,
): {
  stillWaiting: boolean
  attentionIntensity: number
} {
  const lastLenRef = useRef(currentResponseLength)
  const lastGrowthAtRef = useRef<number | null>(null)
  if (currentResponseLength > lastLenRef.current) {
    lastGrowthAtRef.current = performance.now()
  } else if (currentResponseLength < lastLenRef.current) {
    lastGrowthAtRef.current = null
  }
  lastLenRef.current = currentResponseLength

  const now = performance.now()
  const lastEventAt = lastGrowthAtRef.current
  const { stillWaiting, targetIntensity } = computeStallView({
    mode,
    suppressed,
    lastEventAt,
    now,
  })

  const intensityRef = useRef(0)
  const lastSmoothAtRef = useRef(time)
  if (targetIntensity === 0 || reducedMotion) {
    intensityRef.current = targetIntensity
    lastSmoothAtRef.current = time
  } else {
    const dt = time - lastSmoothAtRef.current
    if (dt >= 50) {
      intensityRef.current = easeAttention(
        intensityRef.current,
        targetIntensity,
        dt,
        false,
      )
      lastSmoothAtRef.current = time
    }
  }

  return { stillWaiting, attentionIntensity: intensityRef.current }
}
