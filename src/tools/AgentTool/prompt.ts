import { MERCURY_SCOUT_AGENT_TYPE } from '../../constants/tools/agent.js'
import type { AgentDefinition } from '../../types/agent.js'
import { SCOUT_TOOLS_DESCRIPTION } from './scoutPolicy.js'
import { notBuilt } from '../../pi/holes.js'

function describeTools(agent: AgentDefinition): string {
  if (agent.source === 'built-in' && agent.agentType === MERCURY_SCOUT_AGENT_TYPE) return SCOUT_TOOLS_DESCRIPTION
  const allow = agent.tools
  const deny = agent.disallowedTools
  const hasAllow = Array.isArray(allow) && allow.length > 0
  const hasDeny = Array.isArray(deny) && deny.length > 0
  if (hasAllow && hasDeny) {
    const effective = allow!.filter(name => !deny!.includes(name))
    return effective.length > 0 ? effective.join(', ') : 'None'
  }
  if (hasAllow) return allow!.join(', ')
  if (hasDeny) return `All tools except ${deny!.join(', ')}`
  return 'All tools'
}

function formatAgentLine(agent: AgentDefinition, refusal?: string): string {
  const line = `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${describeTools(agent)})`
  return refusal === undefined ? line : `${line} — ${refusal}`
}

const AGENT_ROSTER_HEAD = 'Agents, by crewmate_type:'
const SEATS_TALK_DIRECTLY = 'Seats talk to each other directly: a board post that starts @seat reaches a running seat at its next step and wakes an idle one, so brief seats to ask each other instead of relaying through you.'

export function agentRosterOf(fullPrompt: string): string {
  const start = fullPrompt.indexOf(AGENT_ROSTER_HEAD)
  if (start === -1) return ''
  const end = fullPrompt.indexOf('\n\n', start)
  return end === -1 ? fullPrompt.slice(start) : fullPrompt.slice(start, end)
}

export function withoutAgentRoster(fullPrompt: string): string {
  const roster = agentRosterOf(fullPrompt)
  return roster === '' ? fullPrompt : fullPrompt.replace(roster, '').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
}

export async function getPrompt(
  agentDefinitions: readonly AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: readonly string[],
  offered?: ReadonlySet<string>,
  refusals?: ReadonlyMap<string, string>,
  swarmOn?: boolean,
): Promise<string> {
  return notBuilt('src/tools/AgentTool/prompt.ts:41')
}
