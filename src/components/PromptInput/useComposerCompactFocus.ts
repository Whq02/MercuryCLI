import type React from 'react'
import { useClaim, useLayoutPublish } from '../../hooks/effects.js'
import { anyModalOverlayActive } from '../../context/overlayStack.js'
import { currentSurfaceRoute } from '../../context/surfaceRoute.js'
import type { AppState } from '../../state/AppState.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'

export function useComposerCompactFocus({
  compactWork,
  summaryVisible,
  modalOverlayUp,
  externalEditorActive,
  isSearchingHistory,
  helpOpen,
  exitState,
  pastePendingRef,
  isCompact,
  footerSelection,
  setAppState,
}: {
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
}) {
  const canFocusSummary = (): boolean => summaryVisible && currentSurfaceRoute().kind === 'repl' && !modalOverlayUp && !externalEditorActive && !isSearchingHistory && !helpOpen && !exitState.pending && !anyModalOverlayActive() && !(pastePendingRef.current?.() ?? false)
  compactWork?.bindToggle(() => {
    if (compactWork.read() === 'summary') { compactWork.set('composer'); return }
    if (canFocusSummary()) compactWork.set('summary')
  })
  useClaim(() => () => compactWork?.bindToggle(null), [compactWork])
  useLayoutPublish(() => {
    if (isCompact && footerSelection !== null) setAppState(prev => ({ ...prev, footerSelection: null }))
  }, [isCompact, footerSelection, setAppState])
  useLayoutPublish(() => {
    if (compactWork?.read() === 'summary' && !canFocusSummary()) compactWork.set('composer')
  }, [summaryVisible, modalOverlayUp, externalEditorActive, isSearchingHistory, helpOpen, exitState.pending, compactWork])
  return canFocusSummary
}
