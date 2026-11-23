import { setPermissionModeChangedListener } from '../../../utils/sessionState.js'
import { modeRow } from '../../../rows/project.js'
import { isOneOf } from '../../../utils/isOneOf.js'
import { startTimeout, stopTimeout } from '../../../utils/timers.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'tellStandingMode'> {
  const { enqueueRow, getAppState, liveScope } = ports
  const MODE_NOTICE_WAIT_MS = 45_000
  const SDK_MODES = ['default', 'implement', 'sovereign', 'flow', 'dontAsk'] as const
  let told = getAppState().toolPermissionContext.mode
  let standing = told
  let wait: NodeJS.Timeout | null = null
  const tellStandingMode = (): void => {
    if (wait === null) return
    stopTimeout(wait)
    wait = null
    if (standing === told) return
    told = standing
    enqueueRow(modeRow(liveScope(), standing))
  }
  setPermissionModeChangedListener(mode => {
    if (!isOneOf(SDK_MODES, mode)) return
    standing = mode
    if (wait !== null) stopTimeout(wait)
    wait = startTimeout(tellStandingMode, MODE_NOTICE_WAIT_MS)
    wait.unref()
  })
  return { tellStandingMode }
}

export const watchMode: BootStep<'tellStandingMode'> = { name: 'watchMode', makes: ['tellStandingMode'], run }
