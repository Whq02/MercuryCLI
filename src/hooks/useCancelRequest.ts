// Cancel / interrupt / kill-agents. Renders nothing; registers
// three handlers with carefully scoped activity. The cancel path reaches
// the focused chat through its engine connector's interrupt door, which
// settles every pending permission ask exactly once before cancelling
// (emptying the queue alone orphans resolvers). The kill-agents handler
// stays ALWAYS registered — its chord prefix is shared with the
// external-editor chord, so an inactive handler would leak the second key
// to the line editor; it gates internally. State reads inside handlers
// come from the store, never a captured render value.

import { useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useIsOverlayActive } from '../context/overlayContext.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import {
  isLocalAgentTask,
  stopRunningAgentTasks,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
// The kill-agents notification lands in the in-process session's queue: the
// background agents belong to the terminal process, whichever chat holds
// the screen.
import { enqueuePendingNotification } from '../input-core/command-queue.js'
import { pressInterrupt } from '../input-core/interruptArity.js'
import { getFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'
import * as pendingInput from '../input-core/pending-input.js'
import type { Screen } from '../screens/REPL.js'
import type { VimMode } from '../types/textInputTypes.js'
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'

const KILL_CONFIRM_WINDOW_MS = 3000
const NONE_RUNNING_TIMEOUT_MS = 2000

/** The shared kill path: stop all running background agents through the
 *  task owner's one road (abort, settle killed, mark notified, the
 *  `stopped` termination events), then enqueue ONE aggregate model-facing
 *  notification. Returns whether anything was killed. */
function killRunningAgents(
  getState: () => AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): boolean {
  const running = stopRunningAgentTasks(getState().tasks, setAppState)
  if (running.length === 0) return false
  const summary =
    running.length === 1
      ? `the background agent "${running[0]!.description}" was stopped`
      : `${running.length} background agents were stopped: ${running
          .map(task => `"${task.description}"`)
          .join(', ')}`
  enqueuePendingNotification({
    value: `<${TASK_NOTIFICATION_TAG}>
<${STATUS_TAG}>killed</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`,
    mode: 'task-notification',
    priority: 'later',
  })
  return true
}

export function CancelRequestHandler({
  isElicitationFocused = false,
  isInterviewFocused = false,
  onAgentsKilled,
  isMessageSelectorVisible = false,
  screen,
  abortSignal,
  vimMode,
  isLocalJSXCommand = false,
  isSearchingHistory = false,
  isHelpOpen = false,
  isInputDialogFocused = false,
  streamMode,
  focusedTurnActive,
}: {
  /** The focused chat's turn when it is a daemon-hosted session (its live
   *  view); undefined when the focused chat is the in-process engine, whose
   *  abort signal answers instead. Escape and the interrupt chord reach
   *  whichever session holds the screen through its connector. */
  focusedTurnActive?: boolean
  isElicitationFocused?: boolean
  /** The interview card owns Escape while focused. */
  isInterviewFocused?: boolean
  onAgentsKilled?: () => void
  isMessageSelectorVisible?: boolean
  screen: Screen
  abortSignal?: AbortSignal
  /** PRESENCE MEANS VIM IS ENABLED — pass undefined when the vim editing
   *  mode is off. The guard treats a defined 'INSERT' as "vim owns Escape";
   *  the REPL's vim state initializes 'INSERT' unconditionally, so passing
   *  it raw stands the Esc-interrupt down for every non-vim session (the
   *  incident; the C2 journey leg pins this). */
  vimMode?: VimMode
  isLocalJSXCommand?: boolean
  isSearchingHistory?: boolean
  isHelpOpen?: boolean
  /** A focused input dialog (permission card, elicitation, …) settles its
   *  own interrupt — the busy ctrl+c press is consumed then, never shared
   *  onward (a fall-through would double-settle through the dialog's own
   *  interrupt handler). */
  isInputDialogFocused?: boolean
  streamMode?: string
}): null {
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const { addNotification, removeNotification } = useNotifications()
  // ANY registered overlay stands the cancel chord down (not modal-only):
  // Escape must dismiss the surface, never cancel the running request.
  const overlayActive = useIsOverlayActive()
  const killChord = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k')
  const killPressAtRef = useRef(0)
  void streamMode

  const taskRunning = focusedTurnActive ?? (abortSignal !== undefined && !abortSignal.aborted)
  const viewingTeammate = store.getState().viewingAgentTaskId !== undefined

  const settleAsksAndCancel = (): void => {
    // The interrupt door settles every pending ask exactly once, then
    // cancels the focused chat's turn.
    getFocusedSessionConnector().interrupt()
  }

  const contextGuardsPass =
    screen !== 'transcript' &&
    !isSearchingHistory &&
    !isMessageSelectorVisible &&
    !isLocalJSXCommand &&
    !isHelpOpen &&
    !overlayActive &&
    !(vimMode !== undefined && vimMode === 'INSERT' && isVimEnabled())

  function isVimEnabled(): boolean {
    return vimMode !== undefined
  }

  // Escape is RELEASED to an elicitation dialog or the interview card (never
  // swallowed) and to the teammate view (the interrupt handler below
  // omits all three).
  const isEscapeActive =
    contextGuardsPass &&
    !isElicitationFocused &&
    !isInterviewFocused &&
    !viewingTeammate &&
    taskRunning

  useKeybinding(
    'chat:cancel',
    () => {
      // Mode-exit decline: mode and text read AT EVENT TIME from the
      // pending-input owner — a render-derived flag would be stale.
      if (pendingInput.mode() !== 'prompt' && pendingInput.text() === '') {
        return false
      }
      if (taskRunning) {
        // The SURFACE-SCOPED INTERRUPT ARM:
        // the chat scope's declared esc arity governs the running-turn
        // interrupt. The default is 1 — ONE esc interrupts, byte-unchanged;
        // a surface declaring arity 2 for its own scope arms first and the
        // hint paints (Minerva's room rides this seam with its own scope).
        const press = pressInterrupt('chat')
        if (!press.fire) {
          addNotification({
            key: 'interrupt-arity',
            text: press.hint,
            priority: 'immediate',
            timeoutMs: press.windowMs,
          })
          return
        }
        settleAsksAndCancel()
        return
      }
      settleAsksAndCancel()
    },
    { context: 'Chat', isActive: isEscapeActive },
  )

  const interruptActive =
    contextGuardsPass && (taskRunning || viewingTeammate)
  useKeybinding(
    'app:interrupt',
    () => {
      // Deliberately WITHOUT the elicitation/interview/teammate-view guards
      // — in the teammate view it kills all agents and leaves.
      const viewingTeammateNow = store.getState().viewingAgentTaskId !== undefined
      if (viewingTeammateNow) {
        const killed = killRunningAgents(() => store.getState() as AppState, setAppState)
        if (killed) onAgentsKilled?.()
        setAppState(prev => ({
          ...prev,
          viewingAgentTaskId: undefined,
          viewSelectionMode: 'none' as const,
        }))
      }
      if (taskRunning) {
        settleAsksAndCancel()
        // The ruled busy grammar: the SAME
        // press that interrupts the turn must also arm the composer's exit
        // chord and its notice. The composer's raw ctrl+c handler registers
        // AFTER this listener, so declining consumption here (false) lets
        // the press reach it. Consumed as before when a teammate view was
        // just left or a focused input dialog owns its own settlement.
        if (!viewingTeammateNow && !isInputDialogFocused) return false
      }
    },
    { context: 'Global', isActive: interruptActive },
  )

  // Kill-agents: ALWAYS registered (the chord prefix is shared); gated
  // internally. Two presses within the window kill.
  useKeybindings(
    {
      'chat:killAgents': () => {
        const running = Object.values(store.getState().tasks).filter(
          task => isLocalAgentTask(task) && task.status === 'running',
        )
        if (running.length === 0) {
          addNotification({
            key: 'kill-agents-none',
            text: 'no background agents are running',
            priority: 'immediate',
            timeoutMs: NONE_RUNNING_TIMEOUT_MS,
          })
          return
        }
        const now = Date.now()
        if (now - killPressAtRef.current <= KILL_CONFIRM_WINDOW_MS) {
          killPressAtRef.current = 0
          removeNotification('kill-agents-confirm')
          const killed = killRunningAgents(() => store.getState() as AppState, setAppState)
          if (killed) onAgentsKilled?.()
          return
        }
        killPressAtRef.current = now
        addNotification({
          key: 'kill-agents-confirm',
          text: `press ${killChord} again to stop the background agents`,
          priority: 'immediate',
          timeoutMs: KILL_CONFIRM_WINDOW_MS,
        })
      },
    },
    { context: 'Chat' },
  )

  return null
}
