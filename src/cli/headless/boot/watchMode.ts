import { setPermissionModeChangedListener } from '../../../utils/sessionState.js'
import { modeRow } from '../../../rows/project.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { enqueueRow, liveScope } = ports
  const SDK_MODES = new Set(['default', 'implement', 'sovereign', 'flow', 'dontAsk'])
  setPermissionModeChangedListener(mode => {
    if (!SDK_MODES.has(mode)) return
    enqueueRow(modeRow(liveScope(), mode))
  })
  return {}
}

export const watchMode: BootStep<never> = { name: 'watchMode', makes: [], run }
