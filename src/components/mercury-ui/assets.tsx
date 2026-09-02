
import * as React from 'react'
import { Box, Text, useTheme } from '../../ink.js'
import { critterDefForKey } from '../../utils/cockpit/critterData.js'
import { resolveMercuryTokens } from '../../utils/mercuryTokens.js'
import { FAINT } from '../mercuryPalette.js'
import { rampSegments } from './focalRamp.js'
import { displayWidth } from './glyphs.js'
import { TwinkleSpark } from './LiveGlyphs.js'
import { useGreetingShimmer } from './useGreetingShimmer.js'
import { useSessionAccent } from './sessionAccent.js'
import { useMercuryTokens } from './useMercuryTokens.js'

export function Crab(): React.ReactNode {
  const { accent, accentDeep } = useSessionAccent()
  return (
    <Text>
      <Text color={accentDeep}>▖</Text>
      <Text color={accent}>▟▆▙</Text>
      <Text color={accentDeep}>▗</Text>
    </Text>
  )
}

export const CrabMark = Crab

export function SessionMark(): React.ReactNode {
  const sa = useSessionAccent()
  const { mark } = critterDefForKey(sa.key)
  return (
    <Text>
      <Text color={sa.accentDeep}>{mark.pre}</Text>
      <Text color={sa.accent}>{mark.core}</Text>
      <Text color={sa.accentDeep}>{mark.post}</Text>
    </Text>
  )
}

export const CRAB_GLYPHS = '▖▟▆▙▗'

export function Wordmark({
  version,
}: {
  version?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const t = useMercuryTokens()
  const [theme] = useTheme()
  const ramp = accent === t.accent ? t.focalRamp : resolveMercuryTokens(theme, accent).focalRamp
  const shimmer = useGreetingShimmer(ramp, displayWidth('Mercury'))
  const segments = rampSegments('Mercury', ramp, { shimmer })
  return (
    <Text>
      {segments.map((s, i) => (
        <Text key={i} bold color={s.color}>
          {s.text}
        </Text>
      ))}
      {version ? <Text color={t.textMuted}> v{version}</Text> : null}
    </Text>
  )
}

const BIG_FONT: Record<string, string[]> = {
  M: ['#...#', '#####', '#.#.#', '#...#', '#...#'],
  E: ['####', '#...', '###.', '#...', '####'],
  R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  C: ['####', '#...', '#...', '#...', '####'],
  U: ['#..#', '#..#', '#..#', '#..#', '####'],
  Y: ['#...#', '#...#', '.###.', '..#..', '..#..'],
}
export function bigWordmarkRows(): string[] {
  const word = 'MERCURY'
  const rows: string[] = []
  for (let r = 0; r < 5; r += 2) {
    let s = ''
    for (let li = 0; li < word.length; li++) {
      const glyph = BIG_FONT[word[li]!] ?? []
      const top = glyph[r] ?? ''
      const bot = glyph[r + 1] ?? ''
      const w = Math.max(top.length, bot.length)
      for (let x = 0; x < w; x++) {
        const t = top[x] === '#'
        const b = bot[x] === '#'
        s += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
      }
      if (li < word.length - 1) s += '  '
    }
    rows.push(s)
  }
  return rows
}

export function BigWordmark(): React.ReactNode {
  const { accent } = useSessionAccent()
  const t = useMercuryTokens()
  const [theme] = useTheme()
  const ramp = accent === t.accent ? t.focalRamp : resolveMercuryTokens(theme, accent).focalRamp
  const rows = bigWordmarkRows()
  const shimmer = useGreetingShimmer(ramp, displayWidth(rows[0] ?? ''))
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((s, r) => (
        <Text key={r}>
          {rampSegments(s, ramp, { shimmer }).map((seg, i) => (
            <Text key={i} color={seg.color}>
              {seg.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export function wordmarkForm(columns: number, rows: number): 'banner' | 'compact' {
  return rows >= 34 && columns >= 48 ? 'banner' : 'compact'
}

export type SigilSize = 'inline' | 'small' | 'medium' | 'large'

const SMALL = ['╲ │ ╱', '──◉──', '╱ │ ╲']
const MEDIUM = ['   │', ' ╲ │ ╱', '───◉───', ' ╱ │ ╲', '   │']
const LARGE = [
  '        ✦        ·',
  '    ╭─────────────╮',
  '  ·                 ·',
  '           │',
  '         ╲ │ ╱',
  ' ·   ───── ◉ ─────   ·',
  '         ╱ │ ╲',
  '           │',
  '  ·                 ·',
  '    ╰─────────────╯',
  '       ·       ✦',
]

function SigilRow({ row }: { row: string }): React.ReactNode {
  const { accent } = useSessionAccent()
  const t = useMercuryTokens()
  return (
    <Text>
      {[...row].map((ch, i) => {
        const color =
          ch === '·'
            ? FAINT
            : ch === '✦' || ch === '✶'
              ? t.accentSoft
              : ch === ' '
                ? undefined
                : accent
        return (
          <Text key={i} color={color}>
            {ch}
          </Text>
        )
      })}
    </Text>
  )
}

export function Sigil({ size = 'small' }: { size?: SigilSize }): React.ReactNode {
  const { accent } = useSessionAccent()
  if (size === 'inline') {
    return <TwinkleSpark color={accent} />
  }
  const rows = size === 'large' ? LARGE : size === 'medium' ? MEDIUM : SMALL
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <SigilRow key={i} row={row} />
      ))}
    </Box>
  )
}
