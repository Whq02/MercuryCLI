import type React from 'react'
import { useClaim, useLayoutPublish } from '../../hooks/effects.js'
import { anyModalOverlayActive } from '../../context/overlayStack.js'
import { currentSurfaceRoute } from '../../context/surfaceRoute.js'
import type { AppState } from '../../state/AppState.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export function useComposerCompactFocus(arg0: {
  compactWork: CompactWorkControls | undefined
  summaryVisible: boolean
  modalOverlayUp: boolean
  externalEditorActive: boolean
  isSearchingHistory: boolean
  helpOpen: boolean
  exitState: { pending: boolean; keyName: string | null }
  pastePendingRef: React.MutableRefObject<(() => boolean) | null>
  isCompact: boolean
  footerSelection: AppState['footerSelection']
  setAppState: (f: (prev: AppState) => AppState) => void
}): Unbuilt {
  return notBuilt('src/components/PromptInput/useComposerCompactFocus.ts:8')
}
