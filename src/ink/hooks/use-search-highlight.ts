
import { useContext, useMemo } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import type { DOMElement } from '../dom.js'
import type { MatchPosition } from '../render-to-screen.js'

export type SearchPositionsState = {
  positions: MatchPosition[]
  rowOffset: number
  colOffset: number
  currentIdx: number
}

export type SearchHighlightApi = {
  setQuery: (query: string) => void
  scanElement: (el: DOMElement) => MatchPosition[]
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
