import { useMemo } from 'react'
import { useTheme } from '../../ink.js'
import { resolveMercuryTokens } from '../../utils/mercuryTokens.js'
import { useSessionAccent } from './sessionAccent.js'

// ============================================================================
//  useSplashCoreAccent — the app-side bridge from the LIVE session accent to
//  the splash core's accent-family contract (GLOW: the boot
//  screens' accent follows the selected critter).
//
//  The in-process Boot faces (BootSplashScreen · BootSettingsScreen) bind
//  createSplashCore to THIS value, so the composed boot chrome wears exactly
//  the identity the session wears — the same selection truth, the same
//  effective-accent ramp law the Wordmark rides (R5: resolveMercuryTokens at
//  the live accent — /accent overrides, the scribe glow, and fable recolors
//  all derive their own ramp instead of collapsing to a family default).
//
//  Families that cannot host the derived ramp (single-stop / unparseable —
//  the reduced-colour collapse law) fall back to the critter KEY, which the
//  core resolves against its BAKED family table — still the right creature,
//  authored hues. The t256 pair is inert in-process (both faces pin
//  truecolor); the crab indexes ride along as honest placeholders.
// ============================================================================

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
        // The hex stops feed useGreetingShimmer's host gate (a single-stop
        // family disables the greeting exactly like the kit surfaces).
        rampStops: tok.focalRamp,
      }
    }
    return { accent: sa.key, rampStops: tok.focalRamp }
  }, [theme, sa.accent, sa.accentDeep, sa.key])
}
