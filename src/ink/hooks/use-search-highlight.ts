// Accessor for the renderer's screen-space search highlight: the inverse
// scan highlight, the element scan, and the position-based current-match
// overlay. Inert ONLY without an instance — these renderer entry points
// carry no alternate-screen guard, and the query is set before the
// alternate screen is entered at boot.

import { useContext, useMemo } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import type { DOMElement } from '../dom.js'
import type { MatchPosition } from '../render-to-screen.js'

export type SearchPositionsState = {
  positions: MatchPosition[]
  rowOffset: number
  /** The scanned element's absolute screen-left, from elementScreenLeft —
   *  scanElement's positions are element-relative in BOTH axes, and the
   *  overlay paints in screen space (FN-016 R6). */
  colOffset: number
  currentIdx: number
}

export type SearchHighlightApi = {
  /** Non-empty: every visible occurrence inverts on the next frame; empty
   *  clears. Screen-space — it matches rendered text. */
  setQuery: (query: string) => void
  /** Paint an existing main-tree element to a fresh screen and scan it;
   *  positions are element-relative (row 0 = element top). */
  scanElement: (el: DOMElement) => MatchPosition[]
  /** The current-match overlay: positions + row offset + current index, or
   *  null to clear. */
  setPositions: (state: SearchPositionsState | null) => void
}

const noop = (): void => {}
const noPositions = (): MatchPosition[] => []

export function useSearchHighlight(): SearchHighlightApi {
  const ink = useContext(InkInstanceContext)
  return useMemo<SearchHighlightApi>(
    () =>
      ink
        ? {
            setQuery: query => ink.setSearchHighlight(query),
            scanElement: el => ink.scanElementSubtree(el),
            setPositions: state => ink.setSearchPositions(state),
          }
        : { setQuery: noop, scanElement: noPositions, setPositions: noop },
    [ink],
  )
}
