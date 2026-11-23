import { armRunnerAgentFreshness } from '../agentFreshness.js'
import { getCwd } from '../../../platform/files/cwd.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'disarmAgentFreshness'> {
  const { live } = ports
  const disarmAgentFreshness = armRunnerAgentFreshness({
    cwd: () => getCwd(),
    getActive: () => live.activeAgents,
    setActive: next => {
      live.activeAgents = next
    },
  })
  return { disarmAgentFreshness }
}

export const armAgentFreshness: BootStep<'disarmAgentFreshness'> = { name: 'armAgentFreshness', makes: ['disarmAgentFreshness'], run }
