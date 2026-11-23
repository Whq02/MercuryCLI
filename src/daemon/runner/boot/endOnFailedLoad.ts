import { BOOT_ENDS, type BootMade, type BootStep, type RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { messages } = ports
  if (messages.length === 0 && process.exitCode !== undefined && process.exitCode !== 0) {
    return BOOT_ENDS
  }
  return {}
}

export const endOnFailedLoad: BootStep<never> = { name: 'endOnFailedLoad', makes: [], run }
