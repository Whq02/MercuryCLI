import { getGlobalConfig, saveGlobalConfig } from '../../platform/settings/config.js'
import { useNotifications } from '../notifications/notifications.js'
import { useKeybinding, useKeybindings } from '../keys/useKeybinding.js'
import { useAppStateStore, useSetAppState } from '../app-state/AppState.js'
import { cycleSurface, enterConcourse } from '../routes/surfaceRoute.js'
import { invokeConcourseCloseChord } from '../concourse-model/closeChordSlot.js'
import { useLayoutChrome } from '../fullscreen-layout/layoutChromeContext.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import instances from '../renderer/instances.js'
import type { Screen } from './Chat.js'

export function GlobalKeybindingHandlers({
  screen,
  setScreen,
  showAllInTranscript,
  setShowAllInTranscript,
  onEnterTranscript,
  onExitTranscript,
  virtualScrollActive = false,
  searchBarOpen = false,
  compactWork,
}: {
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
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const { addNotification } = useNotifications()
  const { isCompact } = useLayoutChrome()

  const notifyRefusal = (outcome: { ok: true } | { ok: false; reason: string }): void => {
    if (outcome.ok) return
    addNotification({
      key: 'surface-route-refused',
      text: outcome.reason,
      color: 'warning',
      priority: 'medium',
      fold: (current, incoming) => ({ ...current, ...incoming }),
    })
  }

  useKeybindings(
    {
      'app:toggleTasks': () => {
        if (isCompact) {
          compactWork?.toggleSummary()
          return
        }
        setAppState(prev => ({
          ...prev,
          expandedView: prev.expandedView === 'tasks' ? 'none' : 'tasks',
        }))
        const nextExpandedView = store.getState().expandedView
        if (getGlobalConfig().expandedView !== nextExpandedView) {
          saveGlobalConfig(current =>
            current.expandedView === nextExpandedView
              ? current
              : { ...current, expandedView: nextExpandedView },
          )
        }
      },
      'app:toggleTranscript': () => {
        setShowAllInTranscript(false)
        if (screen === 'transcript') {
          setScreen('prompt')
          onExitTranscript?.()
        } else {
          setScreen('transcript')
          onEnterTranscript?.()
        }
      },
      'app:redraw': () => {
        instances.get(process.stdout)?.repaintAltScreen()
      },
    },
    { context: 'Global' },
  )

  useKeybindings(
    {
      'app:cycleSurfaceForward': () => {
        notifyRefusal(cycleSurface(1))
      },
      'app:cycleSurfaceBack': () => {
        notifyRefusal(cycleSurface(-1))
      },
      'app:surfaceRight': () => {
        notifyRefusal(cycleSurface(-1))
      },
      'app:surfaceLeft': () => {
        notifyRefusal(cycleSurface(1))
      },
      'app:openSurfaceSwitcher': () => {
        notifyRefusal(enterConcourse())
      },
      'concourse:closeSession': () => {
        invokeConcourseCloseChord()
      },
    },
    { context: 'Global', routeSafe: true },
  )

  useKeybinding(
    'transcript:toggleShowAll',
    () => {
      setShowAllInTranscript(!showAllInTranscript)
    },
    {
      context: 'Transcript',
      isActive: screen === 'transcript' && !virtualScrollActive,
    },
  )

  useKeybinding(
    'transcript:exit',
    () => {
      setShowAllInTranscript(false)
      setScreen('prompt')
      onExitTranscript?.()
    },
    {
      context: 'Transcript',
      isActive: screen === 'transcript' && !searchBarOpen,
    },
  )

  return null
}
