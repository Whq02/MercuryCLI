import { takeFirstPrompt } from '../sessionStart.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { io } = ports
  const hookFirstPrompt = takeFirstPrompt()
  if (hookFirstPrompt) {
    io.prependUserMessage(hookFirstPrompt)
  }
  return {}
}

export const prependFirstPrompt: BootStep<never> = { name: 'prependFirstPrompt', makes: [], run }
