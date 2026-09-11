import cliBoxes from 'cli-boxes'
import { stringWidth } from '../../ink/stringWidth.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { paneWindow, shedToFit } from '../mercury-ui/geometry.js'
import { composerBorderStyle } from '../mercury-ui/replFloor.js'

export const COMPACT_SPLIT_MIN_COLS = 60
export const COMPACT_LIST_FRAME_COLS = 28
export const COMPACT_FRAME_GAP_COLS = 1
export const COMPACT_FRAME_MIN_ROWS = 3
export const COMPACT_MIRROR_KEEP_ROWS = 3

export type CompactConcourseProfile = 'split' | 'single'

export function compactConcourseProfileOf(cols: number): CompactConcourseProfile {
  return cols >= COMPACT_SPLIT_MIN_COLS ? 'split' : 'single'
}

export interface CompactFrameSpan {
  x0: number
  x1: number
  inner: number
}

export interface CompactConcourseGeometry {
  profile: CompactConcourseProfile
  cols: number
  rows: number
  framed: boolean
  inner: number
  list: CompactFrameSpan
  live: CompactFrameSpan
  listFootRows: 0 | 1
  newSessionRows: 0 | 1 | 2
  listWindowRows: number
  liveFootRows: 0 | 1
  composerRows: number
  composerBand: number
  mirrorRows: number
}

function spanOf(x0: number, x1: number): CompactFrameSpan {
  return { x0, x1, inner: Math.max(0, x1 - x0 + 1 - 2) }
}

export function compactConcourseGeometry(
  cols: number,
  rows: number,
  facts: { sessionCount: number; newSessionDoor: boolean; composerBand: number },
): CompactConcourseGeometry {
  const profile = compactConcourseProfileOf(cols)
  const width = Math.max(0, Math.floor(cols))
  const height = Math.max(0, Math.floor(rows))
  const framed = height >= COMPACT_FRAME_MIN_ROWS && width >= COMPACT_FRAME_MIN_ROWS
  const inner = framed ? height - 2 : height
  const list = profile === 'split' ? spanOf(0, COMPACT_LIST_FRAME_COLS - 1) : spanOf(0, width - 1)
  const live = profile === 'split' ? spanOf(COMPACT_LIST_FRAME_COLS + COMPACT_FRAME_GAP_COLS, width - 1) : spanOf(0, width - 1)
  const listFootRows: 0 | 1 = framed && inner >= 2 ? 1 : 0
  const listBudget = inner - listFootRows
  const spare = listBudget - Math.max(1, facts.sessionCount)
  const newSessionRows: 0 | 1 | 2 = !facts.newSessionDoor ? 0 : spare >= 2 ? 2 : spare >= 1 ? 1 : 0
  const listWindowRows = Math.max(0, listBudget - newSessionRows)
  const liveFootRows: 0 | 1 = framed && inner >= 2 ? 1 : 0
  const available = inner - liveFootRows
  const borderRows = composerBorderStyle(height) !== undefined ? 2 : 0
  let composerRows = 0
  let composerBand = 0
  if (facts.composerBand > 0 && available >= borderRows + 1) {
    composerBand = Math.max(1, Math.min(facts.composerBand, available - borderRows - COMPACT_MIRROR_KEEP_ROWS))
    composerRows = borderRows + composerBand
    if (composerRows > available) {
      composerRows = 0
      composerBand = 0
    }
  }
  const mirrorRows = Math.max(0, available - composerRows)
  return {
    profile,
    cols: width,
    rows: height,
    framed,
    inner,
    list,
    live,
    listFootRows,
    newSessionRows,
    listWindowRows,
    liveFootRows,
    composerRows,
    composerBand,
    mirrorRows,
  }
}

export interface CompactListWindow {
  start: number
  end: number
  above: number
  below: number
  moreRow: 0 | 1
}

export function compactListWindow(total: number, selectedIndex: number, windowRows: number): CompactListWindow {
  if (windowRows <= 0 || total <= 0) return { start: 0, end: 0, above: 0, below: total, moreRow: 0 }
  if (total <= windowRows) return { start: 0, end: total, above: 0, below: 0, moreRow: 0 }
  const span = Math.max(1, windowRows - 1)
  const win = paneWindow(total, selectedIndex, span)
  return { ...win, moreRow: windowRows >= 2 ? 1 : 0 }
}

export type CompactFrameGlyphs = { topLeft: string; top: string; topRight: string; left: string; right: string; bottomLeft: string; bottom: string; bottomRight: string }

export function compactFrameGlyphs(bold: boolean): CompactFrameGlyphs {
  const style = bold ? cliBoxes.bold : cliBoxes.round
  return {
    topLeft: style.topLeft,
    top: style.top,
    topRight: style.topRight,
    left: style.left,
    right: style.right,
    bottomLeft: style.bottomLeft,
    bottom: style.bottom,
    bottomRight: style.bottomRight,
  }
}

export function compactFrameTop(title: string, width: number, glyphs: CompactFrameGlyphs = compactFrameGlyphs(false)): string {
  if (width < 2) return glyphs.top.repeat(Math.max(0, width))
  const room = width - 2
  if (room < 3) return `${glyphs.topLeft}${glyphs.top.repeat(room)}${glyphs.topRight}`
  const text = truncateToWidth(title, room - 2)
  const fill = Math.max(0, room - 1 - stringWidth(text) - 1)
  return `${glyphs.topLeft}${glyphs.top}${text} ${glyphs.top.repeat(fill)}${glyphs.topRight}`
}

export function compactFrameBottom(width: number, glyphs: CompactFrameGlyphs = compactFrameGlyphs(false)): string {
  if (width < 2) return glyphs.bottom.repeat(Math.max(0, width))
  return `${glyphs.bottomLeft}${glyphs.bottom.repeat(width - 2)}${glyphs.bottomRight}`
}

export function compactListTitle(count: number, filterText: string): string {
  const trimmed = filterText.trim()
  return trimmed.length > 0 ? `sessions · ${count} · /${trimmed}` : `sessions · ${count}`
}

export function compactLiveTitle(row: { title: string; stateWord: string; ageLabel?: string | null } | undefined): string {
  if (row === undefined) return 'live view'
  const age = row.ageLabel !== undefined && row.ageLabel !== null && row.ageLabel.length > 0 ? ` · ${row.ageLabel}` : ''
  return `${row.title} · ${row.stateWord}${age}`
}

const RUNNING_STATES = new Set(['working', 'starting', 'attached', 'needs-you', 'stalled'])
const FINISHED_STATES = new Set(['ready-to-review', 'completed', 'failed', 'cancelled', 'stopped'])

export function compactBoardTitle(rows: ReadonlyArray<{ state: string; door?: unknown }>): string {
  let running = 0
  let finished = 0
  for (const r of rows) {
    if (r.door !== undefined) continue
    if (RUNNING_STATES.has(r.state)) running += 1
    else if (FINISHED_STATES.has(r.state)) finished += 1
  }
  return `Session Concourse · ${running} running · ${finished} finished`
}

export const COMPACT_LIST_FOOT = '↑↓ pick · ↵ steer'
export const COMPACT_LIST_FOOT_REDUCED = '↑↓ pick · ↵ enter'
export const COMPACT_FILTER_TAIL = '↵ apply · esc clear'
export const COMPACT_FILTER_FOOT = `type to filter · ${COMPACT_FILTER_TAIL}`
export const COMPACT_OPENED_FOOT = '↵ send · x stop · p pause · esc back'
export const COMPACT_OPENED_FOOT_REDUCED = '↵ enter · x stop · p pause · esc back'

export function compactListFoot(facts: { filtering: boolean; reduced: boolean }): string {
  if (facts.filtering) return COMPACT_FILTER_FOOT
  return facts.reduced ? COMPACT_LIST_FOOT_REDUCED : COMPACT_LIST_FOOT
}

export function compactLiveFoot(facts: { verbsFire: boolean }): string {
  return facts.verbsFire ? '⇥ list · x stop · p pause · esc board' : '⇥ list · esc board'
}

const BOARD_FOOT_PARTS = [
  { text: '↵ open', priority: 5 },
  { text: 'n new', priority: 4 },
  { text: '/ filter', priority: 1 },
  { text: '? keys', priority: 2 },
  { text: 'esc boot face', priority: 3 },
] as const

export function compactBoardFoot(width: number, facts: { filtering: boolean; newSessionDoor: boolean }): string {
  if (facts.filtering) return COMPACT_FILTER_FOOT
  const parts = BOARD_FOOT_PARTS.filter(p => facts.newSessionDoor || p.text !== 'n new')
  const whole = parts.map(p => p.text).join(' · ')
  if (stringWidth(whole) <= width) return whole
  const short = parts.filter(p => p.priority >= 3).map(p => (p.text === 'esc boot face' ? 'esc' : p.text))
  const shortLine = short.join(' · ')
  if (stringWidth(shortLine) <= width) return shortLine
  return shedToFit(short.map(t => ({ text: t, priority: t === '↵ open' ? 3 : t === 'esc' ? 2 : 1 })), width, ' · ')
    .map(p => p.text)
    .join(' · ')
}

export function compactOpenedFoot(facts: { reduced: boolean; verbsFire: boolean; draftHeld: boolean }): string {
  if (facts.reduced) return COMPACT_OPENED_FOOT_REDUCED
  const send = facts.draftHeld ? '↵ send' : '↵ enter'
  return facts.verbsFire ? `${send} · x stop · p pause · esc back` : `${send} · esc back`
}

export function compactSteerable(row: { sessionId: string; state: string; door?: unknown }, facts: { reduced: boolean; olderPrefix: string }): boolean {
  if (facts.reduced) return false
  if (row.door !== undefined) return false
  if (row.sessionId.startsWith(facts.olderPrefix) || row.sessionId.startsWith('dispatch:')) return false
  return row.state !== 'parked'
}

export const COMPACT_LIST_ROW_LEAD = 5

export function compactListRowText(row: { title: string }, selected: boolean, inner: number, glyph: string): { lead: string; name: string } {
  const lead = ` ${selected ? '❯' : ' '} ${glyph} `
  const budget = Math.max(0, inner - COMPACT_LIST_ROW_LEAD - 1)
  return { lead, name: truncateToWidth(row.title, budget) }
}

export const COMPACT_NEW_SESSION_ROW = '   n  new session'
export const COMPACT_STATE_COL = 10
export const COMPACT_AGE_COL = 5

export function compactBoardRowText(
  row: { title: string; stateWord: string; ageLabel?: string | null },
  selected: boolean,
  inner: number,
  glyph: string,
): { lead: string; name: string; state: string; age: string } {
  const lead = ` ${selected ? '❯' : ' '} ${glyph} `
  const tail = inner >= COMPACT_LIST_ROW_LEAD + 12 + COMPACT_STATE_COL + COMPACT_AGE_COL + 2
  const state = tail ? row.stateWord.slice(0, COMPACT_STATE_COL).padEnd(COMPACT_STATE_COL) : ''
  const age = tail ? (row.ageLabel ?? '—').slice(0, COMPACT_AGE_COL).padStart(COMPACT_AGE_COL) : ''
  const budget = Math.max(0, inner - COMPACT_LIST_ROW_LEAD - (tail ? COMPACT_STATE_COL + COMPACT_AGE_COL + 3 : 1))
  return { lead, name: truncateToWidth(row.title, budget), state, age }
}
