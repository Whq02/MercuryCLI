
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { useNotifications } from '../context/notifications.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppStateStore, useSetAppState, type AppState } from '../state/AppState.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { cycleSurface, enterConcourse } from '../context/surfaceRoute.js'
import { invokeConcourseCloseChord } from '../services/concourse/closeChordSlot.js'
import { chromeModeLive } from './useLayoutTier.js'
import { useTerminalSize } from './useTerminalSize.js'
import { isFullscreenActive } from '../utils/fullscreen.js'
import instances from '../ink/instances.js'
import type { Screen } from '../screens/REPL.js'

export function GlobalKeybindingHandlers({
  screen,
  setScreen,
  showAllInTranscript,
  setShowAllInTranscript,
  messageCount,
  onEnterTranscript,
  onExitTranscript,
  virtualScrollActive = false,
  searchBarOpen = false,
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
}): null {
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const { addNotification } = useNotifications()
  const { columns, rows } = useTerminalSize()
  void messageCount
  void showAllInTranscript

  const cockpit =
    isFullscreenActive() && chromeModeLive(columns, rows) === 'cockpit'

  const reportRefusal = (reason: string): void => {
    addNotification({
      key: 'surface-route-refused',
      text: reason,
      color: 'warning',
      priority: 'medium',
      fold: (accumulator, incoming) => ({ ...accumulator, ...incoming }),
    })
  }

  useKeybindings(
    {
      'app:toggleTasks': () => {
        setAppState(prev => {
          const teammatesPresent = Object.values(prev.tasks).some(
            task => isInProcessTeammateTask(task) && task.status === 'running',
          )
          if (cockpit) {
            if (!teammatesPresent) return prev
            return {
              ...prev,
              expandedView: prev.expandedView === 'teammates' ? ('none' as const) : ('teammates' as const),
            }
          }
          if (teammatesPresent) {
            const next: AppState['expandedView'] =
              prev.expandedView === 'none'
                ? 'tasks'
                : prev.expandedView === 'tasks'
                  ? 'teammates'
                  : 'none'
            return { ...prev, expandedView: next }
          }
          return {
            ...prev,
            expandedView: prev.expandedView === 'tasks' ? ('none' as const) : ('tasks' as const),
          }
        })
        const remembered = store.getState().expandedView
        if (getGlobalConfig().expandedView !== remembered) {
          saveGlobalConfig(current => ({ ...current, expandedView: remembered }))
        }
      },
      'app:toggleTranscript': () => {
        if (screen === 'transcript') {
          setShowAllInTranscript(false)
          setScreen('prompt' as Screen)
          onExitTranscript?.()
        } else {
          setShowAllInTranscript(false)
          setScreen('transcript' as Screen)
          onEnterTranscript?.()
        }
      },
      'app:toggleTeammatePreview': () => {
        setAppState(prev => ({
          ...prev,
          showTeammateMessagePreview: prev.showTeammateMessagePreview !== true,
        }))
      },
      'app:redraw': () => {
        instances.get(process.stdout)?.repaintAltScreen()
        void store
      },
    },
    { context: 'Global' },
  )

  const step = (dir: 1 | -1): void => {
    const outcome = cycleSurface(dir)
    if (!outcome.ok) reportRefusal(outcome.reason)
  }
  useKeybindings(
    {
      'app:cycleSurfaceForward': () => step(1),
      'app:cycleSurfaceBack': () => step(-1),
      'app:surfaceRight': () => step(-1),
      'app:surfaceLeft': () => step(1),
      'app:openSurfaceSwitcher': () => {
        const outcome = enterConcourse()
        if (!outcome.ok) reportRefusal(outcome.reason)
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
      setScreen('prompt' as Screen)
      onExitTranscript?.()
    },
    {
      context: 'Transcript',
      isActive: screen === 'transcript' && !searchBarOpen,
    },
  )

  return null
}
