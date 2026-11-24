import { useRef, useSyncExternalStore } from 'react'
import { useNotifications, type Notification } from '../notifications/notifications.js'
import { useIsOverlayActive } from '../overlays/overlayHooks.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { useAppStateStore, useSetAppState } from '../app-state/AppState.js'
import type { AppState } from '../app-state/AppStateStore.js'
import {
  isCrewmateTask,
  stopRunningCrewmateTasks,
} from '../../engine/tasks/local-agent/crewmateTask.js'
import { enqueuePendingNotification } from '../composer/input-core/command-queue.js'
import { useFocusedShellRunning } from '../../engine/connector/shellRunning.js'
import { requestShellBackground } from '../../tools/shell/backgroundRequest.js'
import { settingsChangeDetector } from '../../platform/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../../platform/settings/snapshot.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { hasSeatLive } from '../../engine/connector/seatLive.js'
import type { CrewmateControlReceiptV1 } from '../../engine/connector/types.js'
import { crewStillRunningLine, interruptReceiptLine } from '../../engine/connector/crewFacts.js'
import { workCounts } from '../../engine/connector/workCounts.js'
import { createSystemMessage } from '../../engine/message-shapes/systemMessages.js'
import * as pendingInput from '../composer/input-core/pending-input.js'
import type { Screen } from './Chat.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { VimMode } from '../composer/input-core/textInput.js'
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../../engine/message-shapes/messageTags.js'
import { interruptCrewmate } from '../tasks/crewmateInterrupt.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const KILL_CONFIRM_WINDOW_MS = 3000
const NONE_RUNNING_TIMEOUT_MS = 2000

export function backgroundShellNotice(receipt: CrewmateControlReceiptV1): Notification | null {
  if (receipt.outcome === 'applied') return null
  return { key: 'background-shell', text: receipt.detail ?? 'no reason given', priority: 'immediate' }
}

export function interruptFocusedTurn(): boolean {
  const focused = getFocusedSessionConnector()
  const running = workCounts(focused.workRoster().rows)
  const press = hasSeatLive(focused) ? focused.status() : null
  if (!focused.interrupt()) return false
  const line = press === null ? crewStillRunningLine(running) : interruptReceiptLine(running, press)
  if (line !== null) {
    if (focused.addDisplayRow !== undefined) focused.addDisplayRow(createSystemMessage(line, 'warning'))
  }
  return true
}

function killRunningCrewmates(
  getState: () => AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): boolean {
  const running = stopRunningCrewmateTasks(getState().tasks, setAppState)
  if (running.length === 0) return false
  const summary =
    running.length === 1
      ? `the background crewmate "${running[0]!.description}" was stopped`
      : `${running.length} background crewmates were stopped: ${running
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

export function InterruptKeys({
  focusedTurnActive,
  compactWork,
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
}: {
  focusedTurnActive?: boolean
  compactWork?: CompactWorkControls
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
  const { addNotification, removeNotification } = useNotifications()
  const isOverlayActive = useIsOverlayActive()
  const appStateStore = useAppStateStore()
  const setAppState = useSetAppState()
  const shellRunning = useFocusedShellRunning()
  useSyncExternalStore(
    settingsChangeDetector.subscribe,
    settingsRevision,
    settingsRevision,
  )
  const viewingAgentTaskId = useSyncExternalStore(
    appStateStore.subscribe,
    () => appStateStore.getState().viewingAgentTaskId,
    () => appStateStore.getState().viewingAgentTaskId,
  )
  const backgroundKeyEnabled =
    getSettingsSnapshot().settings.view?.backgroundKey !== false
  const killAgentsChord = useShortcutDisplay(
    'chat:killAgents',
    'Chat',
    'ctrl+x ctrl+k',
  )
  const lastKillPressRef = useRef<number | null>(null)

  const turnActive =
    focusedTurnActive !== undefined
      ? focusedTurnActive
      : Boolean(abortSignal && !abortSignal.aborted)

  const sharedGuard =
    screen !== 'transcript' &&
    !isSearchingHistory &&
    !isMessageSelectorVisible &&
    !isLocalJSXCommand &&
    !isHelpOpen &&
    !isOverlayActive &&
    vimMode !== 'INSERT'

  const escapeEligible =
    sharedGuard &&
    !isElicitationFocused &&
    !isInterviewFocused &&
    !viewingAgentTaskId &&
    turnActive

  const backgroundActive = escapeEligible && shellRunning && backgroundKeyEnabled

  const settleAndInterruptFocused = (): void => {
    const focused = getFocusedSessionConnector()
    for (const ask of focused.asks()) {
      focused.settleAsk(ask.id)
    }
    interruptFocusedTurn()
  }

  const runBackground = (allowLegacy: boolean): false | void => {
    if (compactWork !== undefined && compactWork.read() !== 'composer') {
      return false
    }
    if (pendingInput.text() !== '') return false
    const focused = getFocusedSessionConnector()
    if (hasSeatLive(focused)) {
      void focused.backgroundShell().then(
        receipt => {
          const notice = backgroundShellNotice(receipt)
          if (notice !== null) addNotification(notice)
        },
        passedOver,
      )
      return
    }
    if (!allowLegacy) return false
    if (requestShellBackground() === 0) return false
  }

  useKeybinding(
    'chat:cancel',
    () => {
      if (compactWork !== undefined && compactWork.read() !== 'composer') {
        return false
      }
      if (pendingInput.mode() !== 'prompt' && pendingInput.text() === '') {
        return false
      }
      settleAndInterruptFocused()
    },
    { context: 'Chat', isActive: escapeEligible },
  )

  useKeybinding(
    'chat:backgroundShell',
    () => runBackground(true),
    { context: 'Chat', isActive: backgroundActive },
  )

  useKeybinding(
    'task:background',
    () => runBackground(false),
    { context: 'Task', isActive: backgroundActive },
  )

  useKeybinding(
    'app:interrupt',
    () => {
      if (compactWork !== undefined) {
        const focus = compactWork.read()
        if (focus === 'detail') return false
        if (focus === 'summary') compactWork.set('composer')
      }
      const state = appStateStore.getState()
      const viewedId = state.viewingAgentTaskId
      if (viewedId) {
        interruptCrewmate(viewedId, state, setAppState)
        return
      }
      if (turnActive) {
        settleAndInterruptFocused()
      }
      if (!isInputDialogFocused) return false
    },
    {
      context: 'Global',
      isActive: sharedGuard && (turnActive || Boolean(viewingAgentTaskId)),
    },
  )

  useKeybinding(
    'chat:killAgents',
    () => {
      const tasks = appStateStore.getState().tasks
      const hasRunning = Object.values(tasks).some(
        task => isCrewmateTask(task) && task.status === 'running',
      )
      if (!hasRunning) {
        lastKillPressRef.current = null
        removeNotification('kill-agents-confirm')
        addNotification({
          key: 'kill-agents-none',
          text: 'no background crewmates are running',
          priority: 'immediate',
          timeoutMs: NONE_RUNNING_TIMEOUT_MS,
        })
        return
      }
      const now = Date.now()
      if (
        lastKillPressRef.current !== null &&
        now - lastKillPressRef.current <= KILL_CONFIRM_WINDOW_MS
      ) {
        lastKillPressRef.current = null
        removeNotification('kill-agents-confirm')
        if (killRunningCrewmates(appStateStore.getState, setAppState)) {
          onAgentsKilled?.()
        }
        return
      }
      lastKillPressRef.current = now
      addNotification({
        key: 'kill-agents-confirm',
        text: `press ${killAgentsChord} again to stop the background crewmates`,
        priority: 'immediate',
        timeoutMs: KILL_CONFIRM_WINDOW_MS,
      })
    },
    { context: 'Chat' },
  )

  return null
}
