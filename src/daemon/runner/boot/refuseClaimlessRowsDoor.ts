import { gracefulShutdownSync } from '../../../platform/processes/gracefulShutdown.js'
import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

const NO_CLAIM_ON_THE_ROWS_DOOR =
  'mercury run was started as a session worker (MERCURY_CONCOURSE_WORKER=1) with no session named, so it waits for a session/claim, and a claim arrives only on the wire of mercury runner: name the session with --session-id, --continue or --resume, or unset MERCURY_CONCOURSE_WORKER'

function run(ports: RunnerPorts): BootMade<never> {
  const { live, options } = ports
  if (live.awaitingSessionClaim && options.door !== 'wire') {
    process.stderr.write(`${NO_CLAIM_ON_THE_ROWS_DOOR}\n`)
    gracefulShutdownSync(2)
    return BOOT_ENDS
  }
  return {}
}

export const refuseClaimlessRowsDoor: BootStep<never> = { name: 'refuseClaimlessRowsDoor', makes: [], run }
