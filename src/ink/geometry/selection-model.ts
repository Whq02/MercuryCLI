export type Point = { col: number; row: number }

type Geometry = { anchor: Point | null; focus: Point | null; isDragging: boolean }
type ModeSpan = { anchorSpan: { lo: Point; hi: Point; kind: 'word' | 'line' } | null }
type ClipBand = { clipLo?: number; clipHi?: number; clipTop?: number; clipBottom?: number }
type ClampDebt = { virtualAnchorRow?: number; virtualFocusRow?: number }
type ScrolledOff = { scrolledOffAbove: string[]; scrolledOffBelow: string[]; scrolledOffAboveSW: boolean[]; scrolledOffBelowSW: boolean[] }

export type SelectionState = Geometry & ModeSpan & ScrolledOff & ClipBand & ClampDebt & { lastPressHadAlt: boolean }

export function createSelectionState(): SelectionState {
  return {
    anchor: null,
    focus: null,
    isDragging: false,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],
    scrolledOffAboveSW: [],
    scrolledOffBelowSW: [],
    lastPressHadAlt: false,
  }
}

const NO_DEBT: ClampDebt = { virtualAnchorRow: undefined, virtualFocusRow: undefined }
const NO_BAND: ClipBand = { clipLo: undefined, clipHi: undefined, clipTop: undefined, clipBottom: undefined }

export function startSelection(s: SelectionState, col: number, row: number): void {
  Object.assign(s, createSelectionState(), NO_DEBT, NO_BAND, { anchor: { col, row }, isDragging: true })
}

const atAnchorBeforeAnyMotion = (s: SelectionState, col: number, row: number): boolean =>
  s.focus === null && s.anchor?.col === col && s.anchor.row === row

export function updateSelection(s: SelectionState, col: number, row: number): void {
  if (!s.isDragging || atAnchorBeforeAnyMotion(s, col, row)) return
  s.focus = { col, row }
}

export function finishSelection(s: SelectionState): void {
  s.isDragging = false
}

export function clearSelection(s: SelectionState): void {
  Object.assign(s, createSelectionState(), NO_DEBT)
}

export type FocusMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd'

export function moveFocus(s: SelectionState, col: number, row: number): void {
  if (s.focus === null) return
  s.focus = { col, row }
  s.anchorSpan = null
  s.virtualFocusRow = undefined
}

export function comparePoints(a: Point, b: Point): number {
  return Math.sign(a.row - b.row) || Math.sign(a.col - b.col)
}

export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== null && s.focus !== null
}

export function selectionBounds(s: SelectionState): { start: Point; end: Point } | null {
  if (s.anchor === null || s.focus === null) return null
  return comparePoints(s.anchor, s.focus) <= 0 ? { start: s.anchor, end: s.focus } : { start: s.focus, end: s.anchor }
}

type Band = [lo: number | undefined, hi: number | undefined]

const bandWithin = (lo: number, hi: number, extent: number): Band => {
  if (lo <= 0 && hi >= extent - 1) return [undefined, undefined]
  const from = Math.max(0, lo)
  return [from, Math.max(from, hi)]
}

export function setSelectionClipBand(
  s: SelectionState,
  lo: number,
  hi: number,
  screenWidth: number,
  top?: number,
  bottom?: number,
  screenHeight?: number,
): void {
  ;[s.clipLo, s.clipHi] = bandWithin(lo, hi, screenWidth)
  if (top === undefined || bottom === undefined || screenHeight === undefined) return
  ;[s.clipTop, s.clipBottom] = bandWithin(top, bottom, screenHeight)
}
