import { armLocalWarm } from '../../../services/providers/local/localWarm.js'
import { buildSideQuestionFallbackParams } from '../../../utils/queryContext.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { assembleTools, getAppState, getReadFileCache, live, messages, options, setAppState } = ports
  armLocalWarm(() => buildSideQuestionFallbackParams({ tools: assembleTools(getAppState()), commands: live.activeCommands, mcpClients: getAppState().mcp.clients, messages, readFileState: getReadFileCache(), getAppState, setAppState, customSystemPrompt: options.systemPrompt, appendSystemPrompt: options.appendSystemPrompt, thinkingConfig: live.thinkingConfig, agents: live.activeAgents }), { live: () => !live.awaitingSessionClaim && live.inFlightAbort === null })
  return {}
}

export const armWarm: BootStep<never> = { name: 'armWarm', makes: [], run }
