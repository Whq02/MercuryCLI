import { useRef, useSyncExternalStore } from 'react'
import { useNotifications, type Notification } from '../context/notifications.js'
import { useIsOverlayActive } from '../context/overlayContext.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import {
  isLocalAgentTask,
  stopRunningAgentTasks,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { enqueuePendingNotification } from '../input-core/command-queue.js'
import { pressInterrupt } from '../input-core/interruptArity.js'
import { useFocusedShellRunning } from '../services/engine-connector/shellRunning.js'
import { requestShellBackground } from '../tools/BashTool/backgroundRequest.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { getSettingsSnapshot, settingsRevision } from '../utils/settings/snapshot.js'
import { getFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'
import { hasSeatLive } from '../services/engine-connector/seatLive.js'
import type { AgentControlReceiptV1 } from '../services/engine-connector/types.js'
import { crewStillRunningLine, interruptReceiptLine } from '../services/engine-connector/crewFacts.js'
import { workCounts } from '../services/engine-connector/workCounts.js'
import type { Message } from '../types/message.js'
import { createSystemMessage } from '../utils/messages/systemMessages.js'
import * as pendingInput from '../input-core/pending-input.js'
import type { Screen } from '../screens/Chat.js'
import type { CompactWorkControls } from '../components/tasks/CompactWorkSummary.js'
import type { VimMode } from '../types/textInputTypes.js'
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import { interruptCrewmate } from '../components/tasks/crewmateInterrupt.js'
import { notBuilt } from '../pi/holes.js'

const KILL_CONFIRM_WINDOW_MS = 3000
const NONE_RUNNING_TIMEOUT_MS = 2000

export function backgroundShellNotice(receipt: AgentControlReceiptV1): Notification | null {
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
    const painter = focused as { addDisplayRow?: (row: Message) => void }
    if (typeof painter.addDisplayRow === 'function') painter.addDisplayRow(createSystemMessage(line, 'warning'))
  }
  return true
}

function killRunningAgents(
  getState: () => AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): boolean {
  const running = stopRunningAgentTasks(getState().tasks, setAppState)
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

export function CancelRequestHandler(arg0: {
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
  return notBuilt('src/hooks/useCancelRequest.ts:81')
}
