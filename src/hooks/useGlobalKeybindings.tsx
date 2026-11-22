import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { useNotifications } from '../context/notifications.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import { cycleSurface, enterConcourse } from '../context/surfaceRoute.js'
import { invokeConcourseCloseChord } from '../services/concourse/closeChordSlot.js'
import { useLayoutChrome } from '../context/layoutChromeContext.js'
import type { CompactWorkControls } from '../components/tasks/CompactWorkSummary.js'
import instances from '../ink/instances.js'
import type { Screen } from '../screens/Chat.js'
import { notBuilt } from '../pi/holes.js'

export function GlobalKeybindingHandlers(arg0: {
  screen: Screen
  setScreen: (screen: Screen) => void
  showAllInTranscript: boolean
  setShowAllInTranscript: (showAll: boolean) => void
  messageCount: number
  onEnterTranscript?: () => void
  onExitTranscript?: () => void
  virtualScrollActive?: boolean
  searchBarOpen?: boolean
  compactWork?: CompactWorkControls
}): null {
  return notBuilt('src/hooks/useGlobalKeybindings.tsx:13')
}
