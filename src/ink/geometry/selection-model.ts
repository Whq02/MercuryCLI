
export type Point = { col: number; row: number }

export type SelectionState = {
  anchor: Point | null
  clipLo?: number
  clipHi?: number
  focus: Point | null
  isDragging: boolean
  anchorSpan: { lo: Point; hi: Point; kind: 'word' | 'line' } | null
  scrolledOffAbove: string[]
  scrolledOffBelow: string[]
  scrolledOffAboveSW: boolean[]
  scrolledOffBelowSW: boolean[]
  virtualAnchorRow?: number
  virtualFocusRow?: number
  lastPressHadAlt: boolean
}

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

export function startSelection(s: SelectionState, col: number, row: number): void {
  s.anchor = { col, row }
  s.clipLo = undefined
  s.clipHi = undefined
  s.focus = null
  s.isDragging = true
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = false
}

export function updateSelection(s: SelectionState, col: number, row: number): void {
  if (!s.isDragging) return
  if (!s.focus && s.anchor && s.anchor.col === col && s.anchor.row === row) return
  s.focus = { col, row }
}

export function finishSelection(s: SelectionState): void {
  s.isDragging = false
}

export function clearSelection(s: SelectionState): void {
  s.anchor = null
  s.focus = null
  s.isDragging = false
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = false
}

export type FocusMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd'

export function moveFocus(s: SelectionState, col: number, row: number): void {
  if (!s.focus) return
  s.anchorSpan = null
  s.focus = { col, row }
  s.virtualFocusRow = undefined
}

export function comparePoints(a: Point, b: Point): number {
  if (a.row !== b.row) return a.row < b.row ? -1 : 1
  if (a.col !== b.col) return a.col < b.col ? -1 : 1
  return 0
}

export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== null && s.focus !== null
}

export function selectionBounds(s: SelectionState): { start: Point; end: Point } | null {
  if (!s.anchor || !s.focus) return null
  return comparePoints(s.anchor, s.focus) <= 0
    ? { start: s.anchor, end: s.focus }
    : { start: s.focus, end: s.anchor }
}

export function setSelectionClipBand(
  s: SelectionState,
  lo: number,
  hi: number,
  screenWidth: number,
): void {
  if (lo <= 0 && hi >= screenWidth - 1) {
    s.clipLo = undefined
    s.clipHi = undefined
    return
  }
  s.clipLo = Math.max(0, lo)
  s.clipHi = Math.max(s.clipLo, hi)
}
