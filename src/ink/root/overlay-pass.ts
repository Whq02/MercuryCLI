import { fluxMark } from '../../utils/flux/fluxProbe.js'
import type { Screen, StylePool } from '../cell-grid.js'
import type { ScrollTranslation } from '../compose-walk.js'
import type { OverlayRecord } from '../geometry/overlay.js'
import { applyPositionedHighlight, type MatchPosition } from '../render-to-screen.js'
import { applySearchHighlight } from '../searchHighlight.js'
import {
  applySelectionOverlay,
  captureScrolledRows,
  hasSelection,
  type SelectionState,
  shiftAnchor,
  shiftSelection,
} from '../geometry/selection.js'

export type SearchPositions = {
  positions: MatchPosition[]
  rowOffset: number
  colOffset: number
  currentIdx: number
}

export type OverlayPassInput = {
  altScreen: boolean
  scrollTranslation: ScrollTranslation | null
  selection: SelectionState
  captureScreen: Screen
  screen: Screen
  stylePool: StylePool
  searchQuery: string
  searchPositions: SearchPositions | null
  onSelectionCleared: () => void
  record?: OverlayRecord
}

export type OverlayPassResult = { selActive: boolean; hlActive: boolean }

export function applyOverlayPass(input: OverlayPassInput): OverlayPassResult {
  const { scrollTranslation, selection } = input

  if (
    scrollTranslation &&
    selection.anchor &&
    selection.anchor.row >= scrollTranslation.viewportTop &&
    selection.anchor.row <= scrollTranslation.viewportBottom
  ) {
    const { delta, viewportTop, viewportBottom } = scrollTranslation
    const capFirst = delta > 0 ? viewportTop : viewportBottom + delta + 1
    const capLast = delta > 0 ? viewportTop + delta - 1 : viewportBottom
    const side: 'above' | 'below' = delta > 0 ? 'above' : 'below'
    if (selection.isDragging) {
      if (hasSelection(selection)) {
        captureScrolledRows(selection, input.captureScreen, capFirst, capLast, side)
      }
      shiftAnchor(selection, -delta, viewportTop, viewportBottom)
      fluxMark('selection:xlate', 1000 + delta + 500)
    } else if (
      !selection.focus ||
      (selection.focus.row >= viewportTop && selection.focus.row <= viewportBottom)
    ) {
      if (hasSelection(selection)) {
        captureScrolledRows(selection, input.captureScreen, capFirst, capLast, side)
      }
      const had = hasSelection(selection)
      shiftSelection(selection, -delta, viewportTop, viewportBottom, input.captureScreen.width)
      if (had && !hasSelection(selection)) input.onSelectionCleared()
      fluxMark('selection:xlate', 2000 + delta + 500)
    } else {
      fluxMark('selection:xlate', 3000 + delta + 500)
    }
  } else if (scrollTranslation && selection.anchor) {
    fluxMark('selection:xlate', 4000 + scrollTranslation.delta + 500)
  }

  let selActive = false
  let hlActive = false
  if (input.altScreen) {
    selActive = hasSelection(selection)
    if (selActive) {
      applySelectionOverlay(input.screen, selection, input.stylePool, input.record)
    }
    hlActive = applySearchHighlight(input.screen, input.searchQuery, input.stylePool, input.record)
    if (input.searchPositions) {
      const sp = input.searchPositions
      const posApplied = applyPositionedHighlight(input.screen, input.stylePool, sp.positions, sp.rowOffset, sp.colOffset, sp.currentIdx, input.record)
      hlActive = hlActive || posApplied
    }
  }
  return { selActive, hlActive }
}
