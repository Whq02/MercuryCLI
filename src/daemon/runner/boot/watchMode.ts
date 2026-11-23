import { setPermissionModeChangedListener } from '../../../permissions/rules/permissionModeListener.js'
import { modeRow } from '../../../engine/rows/project.js'
import type { PermissionMode } from '../../../permissions/rules/permissions.js'
import { markSessionPermissionMode } from '../../../screen/cockpit/runtimePosture.js'
import { wrapInSystemReminder } from '../../../engine/message-shapes/text.js'
import type { QueuedCommand } from '../../../screen/composer/input-core/textInput.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'noteOperatorMode' | 'takeModeNotice'> {
  const { enqueueRow, liveScope } = ports
  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'flow', 'dontAsk'])
  let standing: PermissionMode | null = null
  const noteOperatorMode = (mode: PermissionMode): void => {
    standing = mode
  }
  const takeModeNotice = (): QueuedCommand | null => {
    if (standing === null) return null
    const reminder = markSessionPermissionMode(standing)
    standing = null
    if (reminder === null) return null
    return { value: wrapInSystemReminder(reminder), mode: 'task-notification' }
  }
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    enqueueRow(modeRow(liveScope(), mode))
  })
  return { noteOperatorMode, takeModeNotice }
}

export const watchMode: BootStep<'noteOperatorMode' | 'takeModeNotice'> = { name: 'watchMode', makes: ['noteOperatorMode', 'takeModeNotice'], run }
