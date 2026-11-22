import { useContext, useMemo } from 'react'
import { InkInstanceContext } from '../components/InkInstanceContext.js'
import type { DOMElement } from '../dom.js'
import type { MatchPosition } from '../render-to-screen.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type SearchPositionsState = Unbuilt

type SearchHighlightApi = Unbuilt

const noop = (): void => {}
const noPositions = (): MatchPosition[] => []

export function useSearchHighlight(): SearchHighlightApi {
  return notBuilt('src/ink/hooks/use-search-highlight.ts:23')
}
