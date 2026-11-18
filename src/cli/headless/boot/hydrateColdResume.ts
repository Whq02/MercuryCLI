import { hydrateResumedRun } from '../resumeHydration.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<never>> {
  const { options } = ports
  if (options.continue || options.resume) await hydrateResumedRun(ports)
  return {}
}

export const hydrateColdResume: BootStep<never> = { name: 'hydrateColdResume', makes: [], run }
