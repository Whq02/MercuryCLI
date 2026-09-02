// Global chords: view cycling, transcript toggle, redraw, surface
// routing, teammate preview. A keystroke must never toggle a surface the
// user cannot see: in the cockpit the tasks step is skipped (the rail owns
// the board) and the toggle is inert without teammates. The surface-routing
// pair is route-safe and reports refusals as a folding warning — never a
// silent no-op; "right" steps the cycle BACKWARDS (the user-facing order is
// the reverse of the router's array order). The terminal-panel toggle chord
// of the base build is NOT registered (ruling 5), and the brief-view
// residue is not built.

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

  // The SAME latched decision the layout paints by (real terminal size —
  // this mounts outside the centre-width override): inside the exit band
  // the rails are still on screen, so the board step must still be skipped.
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
      'app:toggleTodos': () => {
        // Teammates-present reads the LIVE state inside the updater; the
        // panel the operator leaves open is remembered across boots and
        // resumes (packet 61).
        setAppState(prev => {
          const teammatesPresent = Object.values(prev.tasks).some(
            task => isInProcessTeammateTask(task) && task.status === 'running',
          )
          if (cockpit) {
            // The rail shows the board permanently: none ↔ teammates when
            // teammates exist; inert otherwise.
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
        // Alternate screen: rewrite every cell in place (no clear first);
        // the inline path falls back to clear-then-redraw (scrollback
        // semantics) inside repaintAltScreen itself.
        instances.get(process.stdout)?.repaintAltScreen()
        void store
      },
    },
    { context: 'Global' },
  )

  // Surface routing: route-safe (fires from every surface); refusals fold.
  // A move onto an absent stop (no chat open) answers `moved: false` and
  // paints NOTHING here — the key-map rows already carry that hint, so the
  // frame stays byte-still; only a real refusal (an inline boot has no
  // frame for the strip) is a note.
  const step = (dir: 1 | -1): void => {
    const outcome = cycleSurface(dir)
    if (!outcome.ok) reportRefusal(outcome.reason)
  }
  useKeybindings(
    {
      'app:cycleSurfaceForward': () => step(1),
      'app:cycleSurfaceBack': () => step(-1),
      // The arrow pair maps user-facing left/right onto the internal cycle
      // at this ONE site: "right" steps backwards, "left" forwards.
      'app:surfaceRight': () => step(-1),
      // From the focused chat ⇧← is the strip's own step to the board (or
      // the boot menu in the plain world): views are not sessions — nothing
      // closes, nothing is handed back, the focused slot keeps its session
      // for the way back.
      'app:surfaceLeft': () => step(1),
      // ctrl+x c was bound + advertised ('session
      // concourse') with NO handler anywhere — a dead advertised key. It now
      // enters the Concourse through the same verb the tag bar uses;
      // refusals fold like every surface move.
      'app:openSurfaceSwitcher': () => {
        const outcome = enterConcourse()
        if (!outcome.ok) reportRefusal(outcome.reason)
      },
      // The Concourse close chord completion: the parked REPL's interceptor
      // owns the chord machinery even while the board covers it (listener
      // order), so the dispatch lands here and crosses on the one-slot seam
      // — the board claims it at mount; unclaimed, the chord means nothing
      // where no board stands and declines without a word.
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
      // An open search bar owns keystrokes; without this gate one Escape is
      // serviced twice (the field cancels AND the transcript exits).
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
