import { setPermissionModeChangedListener } from '../../../utils/sessionState.js'
import { modeRow } from '../../../rows/project.js'
import { markSessionPermissionMode } from '../../../utils/cockpit/runtimePosture.js'
import { enqueuePendingNotification } from '../../../utils/messageQueueManager.js'
import { wrapInSystemReminder } from '../../../utils/messages/text.js'
import { startTimeout, stopTimeout, type TimerHandle } from '../../../utils/timers.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'tellStandingMode'> {
  const { enqueueRow, liveScope } = ports
  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'flow', 'dontAsk'])
  const MODE_REMINDER_WAIT_MS = 45_000
  let waiting: { mode: string; timer: TimerHandle } | null = null
  const tellStandingMode = (): void => {
    if (waiting === null) return
    const { mode, timer } = waiting
    waiting = null
    stopTimeout(timer)
    const reminder = markSessionPermissionMode(mode)
    if (reminder === null) return
    enqueuePendingNotification({ value: wrapInSystemReminder(reminder), mode: 'task-notification', priority: 'next', ridesNextWords: true })
  }
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    enqueueRow(modeRow(liveScope(), mode))
    stopTimeout(waiting?.timer)
    const timer = startTimeout(tellStandingMode, MODE_REMINDER_WAIT_MS)
    timer.unref()
    waiting = { mode, timer }
  })
  return { tellStandingMode }
}

export const watchMode: BootStep<'tellStandingMode'> = { name: 'watchMode', makes: ['tellStandingMode'], run }
