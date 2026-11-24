import { type TurnDriver, createTurnDriver } from '../turnDriver.js'
import * as printDriver from '../runnerDriver.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'driver'> {
  const driver: TurnDriver = createTurnDriver(printDriver.runnerDriverPorts(ports))
  return { driver }
}

export const startDriver: BootStep<'driver'> = { name: 'startDriver', makes: ['driver'], run }
