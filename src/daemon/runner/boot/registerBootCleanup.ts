import { logForDiagnosticsNoPII } from '../../../platform/logs/diagnosticsLog.js'
import { getRunningTasks } from '../../../engine/task-framework/taskRegistry.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { stopInterval, stopTimeout } from '../../../platform/async/timers.js'

async function run(ports: RunnerPorts): Promise<BootMade<'registerCleanup'>> {
  const { buildBehindFloor, driver, getAppState, idleNudge, live, releaseHookRows, stopHostNotices, stopParty, swarmLead, swarmResumes } = ports
  const { registerCleanup } = await import('../../../platform/processes/cleanupRegistry.js')
  registerCleanup(async () => {
    if (buildBehindFloor !== null) stopInterval(buildBehindFloor)
    if (live.buildBehindConfirm !== null) stopTimeout(live.buildBehindConfirm)
    releaseHookRows?.()
    idleNudge.stop()
    stopHostNotices()
    stopParty()
    swarmLead.stop()
    swarmResumes.stop()
    logForDiagnosticsNoPII('info', 'headless_sigterm_state', {
      cycle_running: driver.isRunning(),
      phase: driver.phase(),
      background_tasks: getRunningTasks(getAppState()).length,
    })
  })
  return { registerCleanup }
}

export const registerBootCleanup: BootStep<'registerCleanup'> = { name: 'registerBootCleanup', makes: ['registerCleanup'], run }
