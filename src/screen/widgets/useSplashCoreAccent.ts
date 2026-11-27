import { useMemo } from 'react'
import { createSplashCore } from '../../../assets/splash/splash-core.mjs'
import { mixToward } from '../renderer/cell-grid.js'
import { ansi16InkCode, colorDepth } from '../renderer/colorize.js'
import { useTheme } from '../themedRenderer.js'
import { resolveMercuryTokens } from '../theme/mercuryTokens.js'
import { useSessionAccent } from './sessionAccent.js'


type Rgb = [number, number, number]

function rgbOf(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return null
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

type SplashCoreAccent =
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

function artRowsFrom<T extends { lines: string[] }>(face: T, basic: { lines: string[] }): T {
  const artAlone = (line: string | undefined): boolean => line !== undefined && /^[ \u2580-\u259f]*[\u2580-\u259f][ \u2580-\u259f]*$/.test(line.replace(/\x1b\[[0-9;]*m/g, ''))
  return { ...face, lines: face.lines.map((line, y) => (artAlone(line) && artAlone(basic.lines[y]) ? basic.lines[y]! : line)) }
}

export function splashCoreFor(accent: SplashCoreAccent): ReturnType<typeof createSplashCore> {
  const full = createSplashCore({ nocolor: false, truecolor: true, accent })
  if (colorDepth() !== '16') return full
  const own = typeof accent === 'string' ? accent : { ...accent, t16: ansi16InkCode(...accent.main), t16deep: ansi16InkCode(...accent.deep), t16mid: ansi16InkCode(...mixToward(accent.deep, accent.main, 0.5)) }
  const basic = createSplashCore({ nocolor: false, truecolor: false, ansi16: true, accent: own })
  return {
    ...full,
    composeLockup: (cols, rows, opts) => artRowsFrom(full.composeLockup(cols, rows, opts), basic.composeLockup(cols, rows, opts)),
    composeCompactFace: (cols, rows, opts) => artRowsFrom(full.composeCompactFace(cols, rows, opts), basic.composeCompactFace(cols, rows, opts)),
    composeBootMenu: (cols, rowsAvail, m) => artRowsFrom(full.composeBootMenu(cols, rowsAvail, m), basic.composeBootMenu(cols, rowsAvail, m)),
  }
}
