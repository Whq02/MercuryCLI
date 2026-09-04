import type { Screen, StylePool } from '../cell-grid.js'
import type { FollowScroll } from '../compose-walk.js'
import type { OverlayRecord } from '../geometry/overlay.js'
import { applyPositionedHighlight, type MatchPosition } from '../render-to-screen.js'
import { applySearchHighlight } from '../searchHighlight.js'
import {
  applySelectionOverlay,
  captureScrolledRows,
  hasSelection,
  type SelectionState,
  shiftAnchor,
  shiftSelectionForFollow,
} from '../geometry/selection.js'

export type SearchPositions = {
  positions: MatchPosition[]
  rowOffset: number
  colOffset: number
  currentIdx: number
}

export type OverlayPassInput = {
  altScreen: boolean
  follow: FollowScroll | null
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
  const { follow, selection } = input

  if (
    follow &&
    selection.anchor &&
    selection.anchor.row >= follow.viewportTop &&
    selection.anchor.row <= follow.viewportBottom
  ) {
    const { delta, viewportTop, viewportBottom } = follow
    if (selection.isDragging) {
      if (hasSelection(selection)) {
        captureScrolledRows(selection, input.captureScreen, viewportTop, viewportTop + delta - 1, 'above')
      }
      shiftAnchor(selection, -delta, viewportTop, viewportBottom)
    } else if (
      !selection.focus ||
      (selection.focus.row >= viewportTop && selection.focus.row <= viewportBottom)
    ) {
      if (hasSelection(selection)) {
        captureScrolledRows(selection, input.captureScreen, viewportTop, viewportTop + delta - 1, 'above')
      }
      const cleared = shiftSelectionForFollow(selection, -delta, viewportTop, viewportBottom)
      if (cleared) input.onSelectionCleared()
    }
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
