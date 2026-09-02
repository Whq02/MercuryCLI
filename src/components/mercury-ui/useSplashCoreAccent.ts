import { useMemo } from 'react'
import { useTheme } from '../../ink.js'
import { resolveMercuryTokens } from '../../utils/mercuryTokens.js'
import { useSessionAccent } from './sessionAccent.js'


type Rgb = [number, number, number]

function rgbOf(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return null
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

export type SplashCoreAccent =
  | string
  | { key: string; main: Rgb; deep: Rgb; soft: Rgb; ramp: Rgb[]; t256: number; t256deep: number }

export function useSplashCoreAccent(): { accent: SplashCoreAccent; rampStops: string[] } {
  const [theme] = useTheme()
  const sa = useSessionAccent()
  return useMemo(() => {
    const tok = resolveMercuryTokens(theme, sa.accent)
    const main = rgbOf(sa.accent)
    const deep = rgbOf(sa.accentDeep)
    const soft = rgbOf(tok.accentSoft)
    const stops = tok.focalRamp.map(rgbOf)
    if (main && deep && soft && stops.length > 1 && stops.every(s => s !== null)) {
      return {
        accent: { key: sa.key, main, deep, soft, ramp: stops as Rgb[], t256: 167, t256deep: 95 },
        rampStops: tok.focalRamp,
      }
    }
    return { accent: sa.key, rampStops: tok.focalRamp }
  }, [theme, sa.accent, sa.accentDeep, sa.key])
}
