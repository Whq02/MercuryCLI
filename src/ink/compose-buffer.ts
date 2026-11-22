import {
  type AnsiCode,
  type StyledChar,
  styledCharsFromTokens,
  tokenize,
} from '@alcalzone/ansi-tokenize'
import { logForDebugging } from '../utils/debug.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { reorderBidi } from './bidi.js'
import { type Rectangle, unionRect } from './layout/geometry.js'
import {
  blitRegion,
  CellWidth,
  extractHyperlinkFromStyles,
  fillRegion,
  filterOutHyperlinkStyles,
  markNoSelectRegion,
  OSC8_PREFIX,
  resetScreen,
  type Screen,
  type StylePool,
  setCellAt,
  shiftRect,
  shiftRows,
} from './cell-grid.js'
import { lineWidth } from './line-width-cache.js'
import { terminalTextCells } from './session/terminalTextCells.js'
import { stringWidth } from './stringWidth.js'
import { widestLine } from './widest-line.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


type ClusteredChar = Unbuilt

type Clip = Unbuilt

type WriteOp = {
  type: 'write'
  x: number
  y: number
  text: string
  softWrap?: boolean[]
}
type FillOp = {
  type: 'fill'
  x: number
  y: number
  width: number
  height: number
  styleId: number
}
type ClipOp = { type: 'clip'; clip: Clip }
type UnclipOp = { type: 'unclip' }
type BlitOp = { type: 'blit'; src: Screen; x: number; y: number; width: number; height: number }
type ClearOp = { type: 'clear'; region: Rectangle; fromAbsolute?: boolean }
type NoSelectOp = { type: 'noSelect'; region: Rectangle }
type ShiftOp = { type: 'shift'; top: number; bottom: number; n: number }
type ShiftRectOp = {
  type: 'shift-rect'
  top: number
  bottom: number
  x0: number
  x1: number
  n: number
}

type Operation =
  | WriteOp
  | FillOp
  | ClipOp
  | UnclipOp
  | BlitOp
  | ClearOp
  | NoSelectOp
  | ShiftOp
  | ShiftRectOp

export const lastComposeCounts: Unbuilt = unbuilt('src/ink/compose-buffer.ts:108')

type Options = Unbuilt

export default class ComposeBuffer {
  width: number
  height: number
  private readonly stylePool: StylePool
  private screen: Screen
  private readonly operations: Operation[] = unbuilt('src/ink/compose-buffer.ts:122')
  private clusterCache: Map<string, ClusteredChar[]> = unbuilt('src/ink/compose-buffer.ts:123')
  private sliceCache: Map<string, string> = unbuilt('src/ink/compose-buffer.ts:124')
  private fillStyleCache: Map<string, number> = unbuilt('src/ink/compose-buffer.ts:125')

  constructor(options: Options) {
    notBuilt('src/ink/compose-buffer.ts:127')
  }

  reset(width: number, height: number, screen: Screen): void {
    return notBuilt('src/ink/compose-buffer.ts:135')
  }

  write(x: number, y: number, text: string, softWrap?: boolean[]): void {
    return notBuilt('src/ink/compose-buffer.ts:146')
  }

  fill(x: number, y: number, width: number, height: number, styledSpace?: string): void {
    return notBuilt('src/ink/compose-buffer.ts:151')
  }

  clip(clip: Clip): void {
    return notBuilt('src/ink/compose-buffer.ts:166')
  }

  unclip(): void {
    return notBuilt('src/ink/compose-buffer.ts:170')
  }

  blit(src: Screen, x: number, y: number, width: number, height: number): void {
    return notBuilt('src/ink/compose-buffer.ts:174')
  }

  shift(top: number, bottom: number, n: number): void {
    return notBuilt('src/ink/compose-buffer.ts:178')
  }

  shiftRect(top: number, bottom: number, x0: number, x1: number, n: number): void {
    return notBuilt('src/ink/compose-buffer.ts:182')
  }

  clear(region: Rectangle, fromAbsolute?: boolean): void {
    return notBuilt('src/ink/compose-buffer.ts:186')
  }

  noSelect(region: Rectangle): void {
    return notBuilt('src/ink/compose-buffer.ts:190')
  }

  get(): Screen {
    return notBuilt('src/ink/compose-buffer.ts:194')
  }


  private applyWrite(op: WriteOp, clip: Clip | undefined): number {
    return notBuilt('src/ink/compose-buffer.ts:294')
  }
}


function firstCodeMismatch(a: AnsiCode[], b: AnsiCode[]): number {
  let at = 0
  while (at < a.length && a[at]!.code === b[at]!.code) at++
  return at < a.length ? at : -1
}

const stylesEqual = (a: AnsiCode[], b: AnsiCode[]): boolean =>
  a === b || (a.length === b.length && firstCodeMismatch(a, b) < 0)

function clusterStyledLine(line: string, pool: StylePool): ClusteredChar[] {
  const chars: StyledChar[] = styledCharsFromTokens(tokenize(line))
  if (chars.length === 0) return []

  const out: ClusteredChar[] = []
  let runChars: string[] = []
  let runStyles: AnsiCode[] = chars[0]!.styles

  const flushRun = (): void => {
    if (runChars.length === 0) return
    const buffer = runChars.join('')
    const hyperlink = extractHyperlinkFromStyles(runStyles) ?? undefined
    const hasOsc8 =
      hyperlink !== undefined ||
      runStyles.some(s => s.code.length >= OSC8_PREFIX.length && s.code.startsWith(OSC8_PREFIX))
    const styleId = pool.intern(hasOsc8 ? filterOutHyperlinkStyles(runStyles) : runStyles)
    for (const { segment } of getGraphemeSegmenter().segment(buffer)) {
      const width = stringWidth(segment)
      const parts = width > 2 && /[\u200C\u200D]/.test(segment) && terminalTextCells().joinerCells > 0
        ? segment.split(/([\u200C\u200D])/).filter(Boolean)
        : [segment]
      for (const value of parts) {
        out.push({ value, width: parts.length === 1 ? width : stringWidth(value), styleId, hyperlink })
      }
    }
    runChars = []
  }

  for (const ch of chars) {
    if (runChars.length > 0 && !stylesEqual(ch.styles, runStyles)) flushRun()
    runChars.push(ch.value)
    runStyles = ch.styles
  }
  flushRun()
  return out
}

function skipEscapeSequence(clusters: ClusteredChar[], i: number): number {
  const next = clusters[i + 1]?.value
  const nextCp = next?.codePointAt(0)
  if (next === '(' || next === ')' || next === '*' || next === '+') {
    return i + 2
  }
  if (next === '[') {
    i++
    while (i < clusters.length - 1) {
      i++
      const c = clusters[i]?.value.codePointAt(0)
      if (c !== undefined && c >= 0x40 && c <= 0x7e) break
    }
    return i
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
    i++
    while (i < clusters.length - 1) {
      i++
      const c = clusters[i]?.value
      if (c === '\x07') break
      if (c === '\x1b' && clusters[i + 1]?.value === '\\') {
        i++
        break
      }
    }
    return i
  }
  if (nextCp !== undefined && nextCp >= 0x30 && nextCp <= 0x7e) {
    return i + 1
  }
  return i
}
