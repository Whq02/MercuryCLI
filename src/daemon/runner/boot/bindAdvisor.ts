import * as runnerDriver from '../runnerDriver.js'
import { landSpawnSwitch as landSwitch } from '../spawnSwitchLanding.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'advisorRoad' | 'landSpawnSwitch'> {
  const advisorRoad = runnerDriver.advisorRoadOf(ports)
  const landSpawnSwitch = (kind: 'subagents', on: boolean): void => landSwitch(kind, on, ports)
  return { advisorRoad, landSpawnSwitch }
}

export const bindAdvisor: BootStep<'advisorRoad' | 'landSpawnSwitch'> = { name: 'bindAdvisor', makes: ['advisorRoad', 'landSpawnSwitch'], run }
