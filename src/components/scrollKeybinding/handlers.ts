import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import type { useSelection } from '../../ink/hooks/use-selection.js'
import type { useKeybindings } from '../../keybindings/useKeybinding.js'
import { topOverlayOwnsPageKeys } from '../../context/overlayStack.js'
import { isCrewViewOpen } from '../../utils/cockpit/crewView.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/components/scrollKeybinding/handlers.ts:19')
}
