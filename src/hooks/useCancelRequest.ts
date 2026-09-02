
import { useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useIsOverlayActive } from '../context/overlayContext.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import {
  isLocalAgentTask,
  killAllRunningAgentTasks,
  markAgentsNotified,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
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

function killRunningAgents(
  getState: () => AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): boolean {
  const running = Object.values(getState().tasks).filter(
    (task): task is LocalAgentTaskState =>
      isLocalAgentTask(task) && task.status === 'running',
  )
  if (running.length === 0) return false
  killAllRunningAgentTasks(getState().tasks, setAppState)
  for (const task of running) {
    markAgentsNotified(task.id, setAppState)
    emitTaskTerminatedSdk(task.id, 'stopped', {
      toolUseId: task.toolUseId,
      summary: task.description,
    })
  }
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
  focusedTurnActive?: boolean
  isElicitationFocused?: boolean
  isInterviewFocused?: boolean
  onAgentsKilled?: () => void
  isMessageSelectorVisible?: boolean
  screen: Screen
  abortSignal?: AbortSignal
  vimMode?: VimMode
  isLocalJSXCommand?: boolean
  isSearchingHistory?: boolean
  isHelpOpen?: boolean
  isInputDialogFocused?: boolean
  streamMode?: string
}): null {
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const { addNotification, removeNotification } = useNotifications()
  const overlayActive = useIsOverlayActive()
  const killChord = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k')
  const killPressAtRef = useRef(0)
  void streamMode

  const taskRunning = focusedTurnActive ?? (abortSignal !== undefined && !abortSignal.aborted)
  const viewingTeammate = store.getState().viewingAgentTaskId !== undefined

  const settleAsksAndCancel = (): void => {
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

  const isEscapeActive =
    contextGuardsPass &&
    !isElicitationFocused &&
    !isInterviewFocused &&
    !viewingTeammate &&
    taskRunning

  useKeybinding(
    'chat:cancel',
    () => {
      if (pendingInput.mode() !== 'prompt' && pendingInput.text() === '') {
        return false
      }
      if (taskRunning) {
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
        if (!viewingTeammateNow && !isInputDialogFocused) return false
      }
    },
    { context: 'Global', isActive: interruptActive },
  )

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
