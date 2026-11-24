import { useContext, useMemo } from 'react'
import { ScreenInstanceContext } from '../elements/InkInstanceContext.js'
import type { DOMElement } from '../dom.js'
import type { MatchPosition } from '../matchPositions.js'

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
  const instance = useContext(ScreenInstanceContext)
  return useMemo<SearchHighlightApi>(() => {
    if (!instance) {
      return {
        setQuery: noop,
        scanElement: noPositions,
        setPositions: noop,
      }
    }
    return {
      setQuery: query => instance.setSearchHighlight(query),
      scanElement: element => instance.scanElementSubtree(element),
      setPositions: state => instance.setSearchPositions(state),
    }
  }, [instance])
}
