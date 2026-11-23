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
}): () => boolean {
  const canFocusSummary = (): boolean =>
    summaryVisible &&
    currentSurfaceRoute().kind === 'repl' &&
    !modalOverlayUp &&
    !anyModalOverlayActive() &&
    !externalEditorActive &&
    !isSearchingHistory &&
    !helpOpen &&
    !exitState.pending &&
    !(pastePendingRef.current?.() ?? false)

  useClaim(() => {
    if (compactWork === undefined) return undefined
    compactWork.bindToggle(() => {
      if (compactWork.read() === 'summary') {
        compactWork.set('composer')
        return
      }
      if (canFocusSummary()) {
        compactWork.set('summary')
      }
    })
    return () => {
      compactWork.bindToggle(null)
    }
  }, [
    compactWork,
    summaryVisible,
    modalOverlayUp,
    externalEditorActive,
    isSearchingHistory,
    helpOpen,
    exitState.pending,
    pastePendingRef,
  ])

  useLayoutPublish(() => {
    if (isCompact && footerSelection !== null) {
      setAppState(prev =>
        prev.footerSelection === null ? prev : { ...prev, footerSelection: null },
      )
    }
    if (
      compactWork !== undefined &&
      compactWork.read() === 'summary' &&
      (!summaryVisible ||
        modalOverlayUp ||
        externalEditorActive ||
        isSearchingHistory ||
        helpOpen ||
        exitState.pending)
    ) {
      compactWork.set('composer')
    }
  }, [
    isCompact,
    footerSelection,
    setAppState,
    compactWork,
    summaryVisible,
    modalOverlayUp,
    externalEditorActive,
    isSearchingHistory,
    helpOpen,
    exitState.pending,
  ])

  return canFocusSummary
}
