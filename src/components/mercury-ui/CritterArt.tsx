import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { applyGazeKey } from '../../utils/cockpit/critterGaze.js'
import {
  cellColor,
  CR_COLS,
  EYE_BG,
  flowDepthFor,
  heroBlinkRows,
  heroContentBounds,
  PUPIL,
  settleDepthFor,
  settleRows,
  SLEEP_CELL,
  sleepBreathArt,
  sleepGlyphAt,
  sleepGlyphsFor,
  sleepPoseFor,
  sleepSlotCountFor,
  sleepZzzArt,
  sleepZzzSlots,
  swayRows,
  type CritterDef,
} from '../../utils/cockpit/critterData.js'


function cellAt(art: string[], r: number, c: number): string {
  return art[r]?.[c] ?? '.'
}

const GLOW_MAX = 0.6

function glowMix(base: string, toward: string, t: number): string {
  const p = (c: string): [number, number, number] | null => {
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c)
    return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null
  }
  const a = p(base)
  const b = p(toward)
  if (!a || !b) return base
  const ch = (x: number, y: number): string =>
    Math.max(0, Math.min(255, Math.round(x + (y - x) * t)))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(a[0], b[0])}${ch(a[1], b[1])}${ch(a[2], b[2])}`
}


type FrameCache = {
  lines: Map<string, React.ReactElement>
  roots: Map<string, React.ReactElement>
}

const LINES_MAX = 96
const ROOTS_MAX = 48
const CONTEXTS_MAX = 4

const FRAME_CACHES = new WeakMap<CritterDef, Map<string, FrameCache>>()

function frameCacheFor(def: CritterDef, context: string): FrameCache {
  let byContext = FRAME_CACHES.get(def)
  if (byContext === undefined) {
    byContext = new Map()
    FRAME_CACHES.set(def, byContext)
  }
  let cache = byContext.get(context)
  if (cache === undefined) {
    if (byContext.size >= CONTEXTS_MAX) byContext.clear()
    cache = { lines: new Map(), roots: new Map() }
    byContext.set(context, cache)
  }
  return cache
}

function paintContextKey(
  def: CritterDef,
  legendOverride: Readonly<Record<string, string>> | undefined,
  glowToward: string | undefined,
  dup: number,
  chunky: boolean,
  gridCols: number,
): string {
  let legend = ''
  if (legendOverride !== undefined) {
    for (const k of Object.keys(legendOverride)) legend += `${k}=${legendOverride[k]},`
  }
  return `${def.hue}|${def.hueDeep}|${sleepGlyphsFor(def)}|${legend}|${glowToward ?? ''}|${dup}|${chunky ? 'k' : 'p'}|${gridCols}`
}

function lineExtras(top: string, bot: string, pupil: string, sleepSlots: readonly number[]): string {
  let extras = ''
  for (let c = 0; c < top.length; c++) {
    if (top[c] === 'P' && bot[c] === 'P') {
      extras += `|${pupil}`
      break
    }
  }
  if (top.includes(SLEEP_CELL) || bot.includes(SLEEP_CELL)) extras += `|${sleepSlots.join(',')}`
  return extras
}

export type CritterFrameOpts = {
  hero?: boolean
  mini?: boolean
  square?: boolean
  pupil?: string
  gazeKey?: string
  swayPhase?: number
  sleepPhase?: number | null
}

export function composeCritterFrame(def: CritterDef, opts: CritterFrameOpts): { art: string[]; sleepSlots: number[] } {
  const { pupil = '●', gazeKey = '', swayPhase = 0, sleepPhase = null, mini = false, hero = false, square = false } = opts
  const usingHero = hero && !!def.heroArt && def.heroArt.length > 0
  const usingSquare = !usingHero && square && !!def.square && def.square.length > 0
  const heroBlink = usingHero && pupil !== '●'
  const form = usingHero ? 'hero' : usingSquare ? 'square' : mini ? 'mini' : 'art'
  const pose = sleepPhase !== null ? sleepPoseFor(def, form) : null
  const flowDepth = pose ? pose.flow : flowDepthFor(def, form)
  const settleDepth = pose ? 0 : settleDepthFor(def, form)
  let art: string[]
  if (usingHero) {
    const gazed = applyGazeKey(pose ? pose.art : def.heroArt!, gazeKey)
    const blinked = heroBlink ? heroBlinkRows(gazed) : gazed
    const breathed = pose ? sleepBreathArt(blinked, swayPhase) : blinked
    const settled = settleRows(breathed, settleDepth, swayPhase)
    const rows = swayRows(settled, flowDepth, swayPhase)
    const [cStart, cEnd] = heroContentBounds(rows)
    art = rows.map(r => r.slice(cStart, cEnd))
  } else if (usingSquare) {
    const base = pose ? pose.art : def.square!
    const gazed = applyGazeKey(base, gazeKey)
    const blinked = pupil !== '●' ? heroBlinkRows(gazed) : gazed
    const breathed = pose ? sleepBreathArt(blinked, swayPhase) : blinked
    const settled = settleRows(breathed, settleDepth, swayPhase)
    art = swayRows(settled, flowDepth, swayPhase)
  } else {
    const base = pose ? pose.art : def.art
    const breathed = pose ? sleepBreathArt(base, swayPhase) : base
    const settled = settleRows(breathed, settleDepth, swayPhase)
    art = swayRows(settled, flowDepth, swayPhase)
  }
  const sleepSlotCount = sleepSlotCountFor(def)
  const sleepSlots = sleepPhase !== null ? sleepZzzSlots(art, sleepSlotCount) : []
  if (sleepPhase !== null) art = sleepZzzArt(art, sleepPhase, sleepSlotCount)
  return { art, sleepSlots }
}

function CritterArtImpl({
  def,
  pupil = '●',
  gazeKey = '',
  swayPhase = 0,
  sleepPhase = null,
  mini = false,
  square = false,
  chunky = false,
  hero = false,
  wide = false,
  legendOverride,
  glowToward,
  lineBg,
}: {
  def: CritterDef
  pupil?: string
  gazeKey?: string
  swayPhase?: number
  sleepPhase?: number | null
  mini?: boolean
  square?: boolean
  chunky?: boolean
  hero?: boolean
  wide?: boolean
  legendOverride?: Readonly<Record<string, string>>
  glowToward?: string
  lineBg?: (line: number) => string | undefined
}): React.ReactNode {
  const usingHero = hero && !!def.heroArt && def.heroArt.length > 0
  const { art, sleepSlots } = composeCritterFrame(def, { hero, mini, square, pupil, gazeKey, swayPhase, sleepPhase })
  const dup = usingHero && wide ? 2 : 1
  const colorOf = (ch: string | undefined): string | undefined =>
    (ch !== undefined && legendOverride?.[ch]) || cellColor(def, ch)

  const gridCols = art.reduce((m, r) => Math.max(m, r.length), CR_COLS)

  const paint = (ch: string | undefined, c: number): string | undefined => {
    const base = colorOf(ch)
    return base !== undefined && glowToward !== undefined
      ? glowMix(base, glowToward, ((c + 0.5) / gridCols) * GLOW_MAX)
      : base
  }

  const lineCount = chunky ? art.length : Math.ceil(art.length / 2)
  const grounds: string[] = []
  for (let i = 0; i < lineCount; i++) grounds.push(lineBg?.(i) ?? '')
  const context = paintContextKey(def, legendOverride, glowToward, dup, chunky, gridCols)
  const cache = frameCacheFor(def, context)
  const frameKey = `${pupil}|${sleepSlots.join(',')}\n${grounds.join('|')}\n${art.join('\n')}`
  const cachedRoot = cache.roots.get(frameKey)
  if (cachedRoot !== undefined) return cachedRoot
  if (cache.lines.size >= LINES_MAX) cache.lines.clear()
  if (cache.roots.size >= ROOTS_MAX) cache.roots.clear()

  if (chunky) {
    const rows: React.ReactNode[] = []
    for (let r = 0; r < art.length; r++) {
      const bg = grounds[r]!
      const lineKey = `${r}|${art[r]}|${bg}${lineExtras(art[r]!, '', pupil, sleepSlots)}`
      const hit = cache.lines.get(lineKey)
      if (hit !== undefined) {
        rows.push(hit)
        continue
      }
      const cells: React.ReactNode[] = []
      for (let c = 0; c < gridCols; c++) {
        const ch = cellAt(art, r, c)
        if (ch === SLEEP_CELL) {
          cells.push(
            <Text key={c} color={paint(SLEEP_CELL, c)}>{`${sleepGlyphAt(def, sleepSlots, c)} `}</Text>,
          )
          continue
        }
        if (ch === 'P') {
          cells.push(
            <Text key={`${c}L`} backgroundColor={EYE_BG} color={PUPIL}>▐</Text>,
          )
          cells.push(
            <Text key={`${c}R`} backgroundColor={EYE_BG} color={PUPIL}>▌</Text>,
          )
          continue
        }
        const col = paint(ch, c)
        cells.push(
          col ? (
            <Text key={c} color={col}>
              ██
            </Text>
          ) : (
            <Text key={c}>{'  '}</Text>
          ),
        )
      }
      const line =
        bg !== '' ? (
          <Box key={r} height={1} flexShrink={0} backgroundColor={bg}>
            <Text>{cells}</Text>
          </Box>
        ) : (
          <Text key={r}>{cells}</Text>
        )
      cache.lines.set(lineKey, line)
      rows.push(line)
    }
    const root = <Box flexDirection="column">{rows}</Box>
    cache.roots.set(frameKey, root)
    return root
  }

  const lines: React.ReactNode[] = []
  for (let r = 0; r < art.length; r += 2) {
    const bg = grounds[r >> 1]!
    const topRow = art[r]!
    const botRow = art[r + 1] ?? ''
    const lineKey = `${r}|${topRow}|${botRow}|${bg}${lineExtras(topRow, botRow, pupil, sleepSlots)}`
    const hit = cache.lines.get(lineKey)
    if (hit !== undefined) {
      lines.push(hit)
      continue
    }
    const cells: React.ReactNode[] = []
    for (let c = 0; c < gridCols; c++) {
      const top = cellAt(art, r, c)
      const bot = cellAt(art, r + 1, c)
      if (top === 'P' && bot === 'P') {
        cells.push(
          <Text key={c} color={PUPIL} backgroundColor={EYE_BG}>
            {pupil}
          </Text>,
        )
        continue
      }
      if (top === SLEEP_CELL && bot === SLEEP_CELL) {
        const zc = paint(SLEEP_CELL, c)
        cells.push(
          <Text key={c} color={zc}>
            {sleepGlyphAt(def, sleepSlots, c).repeat(dup)}
          </Text>,
        )
        continue
      }
      const tc = paint(top, c)
      const bc = paint(bot, c)
      if (!tc && !bc) {
        cells.push(<Text key={c}>{' '.repeat(dup)}</Text>)
      } else if (tc && bc) {
        cells.push(
          <Text key={c} color={tc} backgroundColor={bc}>
            {'▀'.repeat(dup)}
          </Text>,
        )
      } else if (tc) {
        cells.push(
          <Text key={c} color={tc}>
            {'▀'.repeat(dup)}
          </Text>,
        )
      } else {
        cells.push(
          <Text key={c} color={bc}>
            {'▄'.repeat(dup)}
          </Text>,
        )
      }
    }
    const line =
      bg !== '' ? (
        <Box key={r} height={1} flexShrink={0} backgroundColor={bg}>
          <Text>{cells}</Text>
        </Box>
      ) : (
        <Text key={r}>{cells}</Text>
      )
    cache.lines.set(lineKey, line)
    lines.push(line)
  }

  const root = <Box flexDirection="column">{lines}</Box>
  cache.roots.set(frameKey, root)
  return root
}

export const CritterArt = React.memo(CritterArtImpl)

export function critterFrameCacheStatsForProofs(def: CritterDef): {
  contexts: number
  lines: number
  roots: number
} {
  const byContext = FRAME_CACHES.get(def)
  if (byContext === undefined) return { contexts: 0, lines: 0, roots: 0 }
  let lines = 0
  let roots = 0
  for (const cache of byContext.values()) {
    lines += cache.lines.size
    roots += cache.roots.size
  }
  return { contexts: byContext.size, lines, roots }
}
