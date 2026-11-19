import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { useSelection } from '../../ink/hooks/use-selection.js'
import type { useKeybindings } from '../../keybindings/useKeybinding.js'
import { topOverlayOwnsPageKeys } from '../../context/overlayStack.js'
import { isCrewViewOpen } from '../../utils/cockpit/crewView.js'

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

export function scrollKeyHandlersOf({ runScroll, pageStep, modalUp, wheelYieldsToTopOverlay, activeHandle, notifyScroll, selection, raiseCopyToast, copyOwnInputSelection }: ScrollKeyArgs): Parameters<typeof useKeybindings>[0] {
  return {
    'scroll:pageUp': () => {
        if (topOverlayOwnsPageKeys()) return false
        if (isCrewViewOpen()) return false
        if (!runScroll(-pageStep())) return false
      },
    'scroll:pageDown': () => {
        if (topOverlayOwnsPageKeys()) return false
        if (isCrewViewOpen()) return false
        if (!runScroll(pageStep())) return false
      },
    'scroll:lineUp': () => {
        if (topOverlayOwnsPageKeys()) return false
        if (wheelYieldsToTopOverlay()) return false
        runScroll(-(modalUp ? 3 : 1))
      },
    'scroll:lineDown': () => {
        if (topOverlayOwnsPageKeys()) return false
        if (wheelYieldsToTopOverlay()) return false
        runScroll(modalUp ? 3 : 1)
      },
    'scroll:top': () => {
        if (topOverlayOwnsPageKeys()) return false
        const handle = activeHandle()
        if (handle) {
          handle.scrollTo(0)
          notifyScroll(handle)
        }
      },
    'scroll:bottom': () => {
        if (topOverlayOwnsPageKeys()) return false
        const handle = activeHandle()
        if (handle) {
          const max = Math.max(
            0,
            handle.getScrollHeight() - handle.getViewportHeight(),
          )
          handle.scrollTo(max)
          handle.scrollToBottom()
          notifyScroll(handle)
        }
      },
    'scroll:halfPageUp': () => {
      runScroll(-Math.max(1, Math.floor((activeHandle()?.getViewportHeight() ?? 2) / 2)))
    },
    'scroll:halfPageDown': () => {
      runScroll(Math.max(1, Math.floor((activeHandle()?.getViewportHeight() ?? 2) / 2)))
    },
    'scroll:fullPageUp': () => {
      runScroll(-Math.max(1, activeHandle()?.getViewportHeight() ?? 1))
    },
    'scroll:fullPageDown': () => {
      runScroll(Math.max(1, activeHandle()?.getViewportHeight() ?? 1))
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
