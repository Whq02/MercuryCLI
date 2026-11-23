import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import type { useSelection } from '../renderer/bindings/use-selection.js'
import type { useKeybindings } from '../keys/useKeybinding.js'
import { topOverlayOwnsPageKeys } from '../overlays/overlayStack.js'
import { isCrewViewOpen } from '../cockpit/crewView.js'

type ScrollKeyArgs = {
  runScroll: (delta: number) => boolean
  pageStep: () => number
  modalUp: boolean
  wheelYieldsToTopOverlay: () => boolean
  activeHandle: () => ScrollBoxHandle | null
  notifyScroll: (handle: ScrollBoxHandle) => void
  selection: ReturnType<typeof useSelection>
  raiseCopyToast: (text: string) => void
  copyOwnInputSelection: () => boolean
}

export function scrollKeyHandlersOf(arg0: ScrollKeyArgs): Parameters<typeof useKeybindings>[0] {
  const {
    runScroll,
    pageStep,
    modalUp,
    wheelYieldsToTopOverlay,
    activeHandle,
    notifyScroll,
    selection,
    raiseCopyToast,
    copyOwnInputSelection,
  } = arg0

  return {
    'scroll:pageUp': () => {
      if (topOverlayOwnsPageKeys() || isCrewViewOpen()) return false
      if (!runScroll(-pageStep())) return false
    },
    'scroll:pageDown': () => {
      if (topOverlayOwnsPageKeys() || isCrewViewOpen()) return false
      if (!runScroll(pageStep())) return false
    },
    'scroll:lineUp': () => {
      if (topOverlayOwnsPageKeys() || wheelYieldsToTopOverlay()) return false
      runScroll(modalUp ? -3 : -1)
    },
    'scroll:lineDown': () => {
      if (topOverlayOwnsPageKeys() || wheelYieldsToTopOverlay()) return false
      runScroll(modalUp ? 3 : 1)
    },
    'scroll:top': () => {
      if (topOverlayOwnsPageKeys()) return false
      const handle = activeHandle()
      if (!handle) return
      handle.scrollTo(0)
      notifyScroll(handle)
    },
    'scroll:bottom': () => {
      if (topOverlayOwnsPageKeys()) return false
      const handle = activeHandle()
      if (!handle) return
      handle.scrollTo(Math.max(0, handle.getScrollHeight() - handle.getViewportHeight()))
      handle.scrollToBottom()
      notifyScroll(handle)
    },
    'scroll:halfPageUp': () => {
      const half = Math.max(1, Math.floor((activeHandle()?.getViewportHeight() ?? 2) / 2))
      runScroll(-half)
    },
    'scroll:halfPageDown': () => {
      const half = Math.max(1, Math.floor((activeHandle()?.getViewportHeight() ?? 2) / 2))
      runScroll(half)
    },
    'scroll:fullPageUp': () => {
      const full = Math.max(1, activeHandle()?.getViewportHeight() ?? 1)
      runScroll(-full)
    },
    'scroll:fullPageDown': () => {
      const full = Math.max(1, activeHandle()?.getViewportHeight() ?? 1)
      runScroll(full)
    },
    'selection:copy': () => {
      if (selection.hasSelection()) {
        const text = selection.copySelection()
        if (text) raiseCopyToast(text)
        return
      }
      copyOwnInputSelection()
    },
  }
}
