import * as inputDoor from '../inputDoor.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  inputDoor.armLocalWake(ports)
  return {}
}

export const armLocalWake: BootStep<never> = { name: 'armLocalWake', makes: [], run }
