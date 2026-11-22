import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type Point = { col: number; row: number }

type Geometry = { anchor: Point | null; focus: Point | null; isDragging: boolean }
type ModeSpan = { anchorSpan: { lo: Point; hi: Point; kind: 'word' | 'line' } | null }
type ClipBand = { clipLo?: number; clipHi?: number; clipTop?: number; clipBottom?: number }
type ClampDebt = Unbuilt

export type SelectionState = Unbuilt

export function createSelectionState(): SelectionState {
  return notBuilt('src/ink/geometry/selection-model.ts:16')
}

const NO_DEBT: ClampDebt = { virtualAnchorRow: undefined, virtualFocusRow: undefined }
const NO_BAND: ClipBand = { clipLo: undefined, clipHi: undefined, clipTop: undefined, clipBottom: undefined }

export function startSelection(s: SelectionState, col: number, row: number): void {
  Object.assign(s, createSelectionState(), NO_DEBT, NO_BAND, { anchor: { col, row }, isDragging: true })
}

const atAnchorBeforeAnyMotion = (s: SelectionState, col: number, row: number): boolean =>
  s.focus === null && s.anchor?.col === col && s.anchor.row === row

export function updateSelection(s: SelectionState, col: number, row: number): void {
  return notBuilt('src/ink/geometry/selection-model.ts:40')
}

export function finishSelection(s: SelectionState): void {
  return notBuilt('src/ink/geometry/selection-model.ts:45')
}

export function clearSelection(s: SelectionState): void {
  return notBuilt('src/ink/geometry/selection-model.ts:49')
}

export type FocusMove = Unbuilt

export function moveFocus(s: SelectionState, col: number, row: number): void {
  return notBuilt('src/ink/geometry/selection-model.ts:55')
}

export function comparePoints(a: Point, b: Point): number {
  return Math.sign(a.row - b.row) || Math.sign(a.col - b.col)
}

export function hasSelection(s: SelectionState): boolean {
  return notBuilt('src/ink/geometry/selection-model.ts:63')
}

export function selectionBounds(s: SelectionState): { start: Point; end: Point } | null {
  return notBuilt('src/ink/geometry/selection-model.ts:67')
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
