import { useContext, useMemo } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import type { DOMElement } from '../dom.js'
import type { MatchPosition } from '../render-to-screen.js'

export type SearchPositionsState = {
  positions: MatchPosition[]
  currentIdx: number
  rowOffset: number
  colOffset: number
}

type SearchHighlightApi = {
  setQuery: (query: string) => void
  scanElement: (element: DOMElement) => MatchPosition[]
  setPositions: (state: SearchPositionsState | null) => void
}

const noop = (): void => {}
const noPositions = (): MatchPosition[] => []

export function useSearchHighlight(): SearchHighlightApi {
  const ink = useContext(InkInstanceContext)
  return useMemo<SearchHighlightApi>(() => {
    if (!ink) {
      return {
        setQuery: noop,
        scanElement: noPositions,
        setPositions: noop,
      }
    }
    return {
      setQuery: query => ink.setSearchHighlight(query),
      scanElement: element => ink.scanElementSubtree(element),
      setPositions: state => ink.setSearchPositions(state),
    }
  }, [ink])
}
