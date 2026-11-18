import { skillChangeDetector } from '../../../utils/skills/skillChangeDetector.js'
import { clearCommandMemoizationCaches, getCommands } from '../../../commands.js'
import { getCwd } from '../../../utils/cwd.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { live } = ports
  skillChangeDetector.subscribe(() => {
    clearCommandMemoizationCaches()
    void getCommands(getCwd()).then(refreshed => {
      live.activeCommands = refreshed
    })
  })
  return {}
}

export const watchSkills: BootStep<never> = { name: 'watchSkills', makes: [], run }
