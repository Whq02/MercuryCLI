import { useRef } from 'react'

export function useOutputRate(chars: number, active: boolean, now: number): number {
  const sample = useRef({ at: 0, chars: 0, rate: 0 })
  if (!active || !Number.isFinite(chars) || chars < sample.current.chars) {
    sample.current = { at: 0, chars, rate: 0 }
    return 0
  }
  if (sample.current.at === 0) {
    sample.current = { at: now, chars, rate: 0 }
    return 0
  }
  const dtMs = now - sample.current.at
  if (dtMs >= 250) {
    const instant = (chars - sample.current.chars) / 4 / (dtMs / 1000)
    sample.current = { at: now, chars, rate: sample.current.rate * 0.6 + instant * 0.4 }
  }
  return Math.round(sample.current.rate)
}
