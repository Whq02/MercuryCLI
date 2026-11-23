import { saveSessionBrief, saveAdvisorSwitch } from '../../../sessions/transcripts/sessionStorage.js'
import { getMainThreadAgentType } from '../../../boot/process-state/processState.js'
import { isBuiltInAgent } from '../../../crew/agents/agentDefinition.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'settleSessionBriefs'> {
  const { agents, live, loaded, options } = ports
  const givenBrief = options.systemPrompt
  const givenBriefAdd = options.appendSystemPrompt
  const hostBriefAdd = options.hostAppendSystemPrompt
  const settleSessionBriefs = (kept: { brief?: string; briefAdd?: string }, record: boolean): void => {
    if (record && givenBrief !== undefined && givenBrief !== kept.brief) saveSessionBrief('brief', givenBrief)
    if (record && options.defaultBrief === true && kept.brief !== undefined) saveSessionBrief('brief', null)
    if (record && givenBriefAdd !== undefined && givenBriefAdd !== kept.briefAdd) saveSessionBrief('briefAdd', givenBriefAdd)
    options.systemPrompt = givenBrief ?? (options.defaultBrief === true ? undefined : kept.brief)
    options.appendSystemPrompt = [hostBriefAdd, givenBriefAdd ?? kept.briefAdd].filter(Boolean).join('\n\n') || undefined
    const mainAgent = agents.find(agent => agent.agentType === getMainThreadAgentType())
    if (mainAgent !== undefined && !isBuiltInAgent(mainAgent) && options.systemPrompt === undefined) {
      const agentPrompt = mainAgent.getSystemPrompt()
      if (agentPrompt) options.systemPrompt = agentPrompt
    }
  }
  settleSessionBriefs(loaded, !live.awaitingSessionClaim)
  if (options.advise === true) saveAdvisorSwitch(true)
  return { settleSessionBriefs }
}

export const settleBriefs: BootStep<'settleSessionBriefs'> = { name: 'settleBriefs', makes: ['settleSessionBriefs'], run }
