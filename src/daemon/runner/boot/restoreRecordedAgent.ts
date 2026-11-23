import { getMainThreadAgentType } from '../../../boot/process-state/processState.js'
import { restoreAgentFromSession } from '../../../sessions/resume/sessionRestore.js'
import { saveAgentSetting } from '../../../sessions/transcripts/sessionStorage.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { agents, loaded, options } = ports
  if (!options.agent && !getMainThreadAgentType() && loaded.agentSetting) {
    const restored = restoreAgentFromSession(loaded.agentSetting, undefined, {
      activeAgents: agents,
      allAgents: agents,
    })
    if (restored.agentType && restored.agentDefinition) saveAgentSetting(restored.agentType)
  }
  return {}
}

export const restoreRecordedAgent: BootStep<never> = { name: 'restoreRecordedAgent', makes: [], run }
