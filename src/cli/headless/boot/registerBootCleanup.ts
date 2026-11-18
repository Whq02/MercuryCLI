import { logForDiagnosticsNoPII } from '../../../utils/diagLogs.js'
import { getRunningTasks } from '../../../utils/task/framework.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<'registerCleanup'>> {
  const { buildBehindFloor, driver, getAppState, idleNudge, live, releaseHookRows, stopHostNotices, stopParty, swarmLead, swarmResumes } = ports
  const { registerCleanup } = await import('../../../utils/cleanupRegistry.js')
  registerCleanup(async () => {
    if (buildBehindFloor !== null) clearInterval(buildBehindFloor)
    if (live.buildBehindConfirm !== null) clearTimeout(live.buildBehindConfirm)
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
