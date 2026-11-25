import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { stopInterval, stopTimeout } from '../../../platform/async/timers.js'

async function run(ports: RunnerPorts): Promise<BootMade<'registerCleanup'>> {
  const { buildBehindFloor, idleNudge, live, releaseHookRows, stopHostNotices, stopParty, swarmLead, swarmResumes } = ports
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
  })
  return { registerCleanup }
}

export const registerBootCleanup: BootStep<'registerCleanup'> = { name: 'registerBootCleanup', makes: ['registerCleanup'], run }
