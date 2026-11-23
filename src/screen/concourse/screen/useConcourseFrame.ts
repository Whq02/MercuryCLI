import { useSyncExternalStore } from 'react'
import { stripKeyMapHint, subscribeSurfaceRoute, surfaceRouteVersion } from '../../routes/surfaceRoute.js'
import { useTerminalSize } from '../../fullscreen-layout/useTerminalSize.js'
import { useLayoutChrome } from '../../fullscreen-layout/layoutChromeContext.js'
import { splitAvailableAt, splitGeometryAt, splitViewOn, splitViewRatio, splitViewVersion, subscribeSplitView } from '../splitView.js'
import { compactConcourseProfileOf } from '../compactBoard.js'
import type { ScreenProps } from './state.js'

export function useConcourseFrame({ reducedStage }: Pick<ScreenProps, 'reducedStage'>) {
  const { columns: termCols, rows: termRows } = useTerminalSize()
  const { isCompact } = useLayoutChrome()
  const compactProfile = isCompact ? compactConcourseProfileOf(termCols, termRows) : null
  const compact = compactProfile !== null
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)
  const keyMapHint = stripKeyMapHint()
  useSyncExternalStore(subscribeSplitView, splitViewVersion, splitViewVersion)
  const splitActive = !reducedStage && !compact && splitViewOn() && splitAvailableAt(termCols, termRows)
  const splitGeo = splitActive ? splitGeometryAt(termCols, splitViewRatio()) : null
  const cols = splitGeo !== null ? splitGeo.boardCols : termCols
  return { termCols, termRows, isCompact, compactProfile, compact, keyMapHint, splitActive, splitGeo, cols }
}
