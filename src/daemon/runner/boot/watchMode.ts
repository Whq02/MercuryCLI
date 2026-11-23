import { setPermissionModeChangedListener } from '../../../permissions/rules/permissionModeListener.js'
import { modeRow } from '../../../engine/rows/project.js'
import type { PermissionMode } from '../../../permissions/rules/permissions.js'
import { markSessionPermissionMode } from '../../../screen/cockpit/runtimePosture.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { wrapInSystemReminder } from '../../../engine/message-shapes/text.js'
import { startTimeout, stopTimeout, type TimerHandle } from '../../../platform/async/timers.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'noteOperatorMode' | 'tellStandingMode'> {
  const { enqueueRow, liveScope } = ports
  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'flow', 'dontAsk'])
  const MODE_REMINDER_WAIT_MS = 45_000
  let waiting: { mode: PermissionMode; timer: TimerHandle } | null = null
  const tellStandingMode = (): void => {
    if (waiting === null) return
    const { mode, timer } = waiting
    waiting = null
    stopTimeout(timer)
    const reminder = markSessionPermissionMode(mode)
    if (reminder === null) return
    enqueuePendingNotification({ value: wrapInSystemReminder(reminder), mode: 'task-notification', priority: 'next', ridesNextWords: true })
  }
  const noteOperatorMode = (mode: PermissionMode): void => {
    stopTimeout(waiting?.timer)
    const timer = startTimeout(tellStandingMode, MODE_REMINDER_WAIT_MS)
    timer.unref()
    waiting = { mode, timer }
  }
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    enqueueRow(modeRow(liveScope(), mode))
  })
  return { noteOperatorMode, tellStandingMode }
}

export const watchMode: BootStep<'noteOperatorMode' | 'tellStandingMode'> = { name: 'watchMode', makes: ['noteOperatorMode', 'tellStandingMode'], run }
