import * as printDriver from '../printDriver.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'idleNudge'> {
  const idleNudge = printDriver.startRunnerIdleNudge(ports)
  return { idleNudge }
}

export const nudgeWhenIdle: BootStep<'idleNudge'> = { name: 'nudgeWhenIdle', makes: ['idleNudge'], run }
