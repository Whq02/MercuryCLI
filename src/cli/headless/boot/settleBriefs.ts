import { saveSessionBrief, saveAdvisorSwitch } from '../../../utils/sessionStorage.js'
import { getMainThreadAgentType } from '../../../bootstrap/state.js'
import { isBuiltInAgent } from '../../../types/agent.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'
import { notBuilt } from '../../../pi/holes.js'

function run(ports: RunnerPorts): BootMade<'settleSessionBriefs'> {
  return notBuilt('src/cli/headless/boot/settleBriefs.ts:6')
}

export const settleBriefs: BootStep<'settleSessionBriefs'> = { name: 'settleBriefs', makes: ['settleSessionBriefs'], run }
