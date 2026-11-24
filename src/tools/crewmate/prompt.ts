import { MERCURY_SCOUT_AGENT_TYPE } from '../kit/names/crewmate.js'
import type { AgentDefinition } from '../../crew/agents/agentDefinition.js'
import { SCOUT_TOOLS_DESCRIPTION } from './scoutPolicy.js'

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

const EXECUTION_TEXT =
  "Launches in one message run concurrently; foreground launches in separate messages run sequentially and wait for the report (returned to you, not directly to the user). Tool access follows the selected agent definition and the session's permissions. Foreground and background launches have the same tool access. With swarm on, a new crewmate is enrolled on the live crew board and told its name, its team and the seats already there; posts arrive as [name] [team] [kind] rows between turns."
const CLEANUP_TEXT =
  'The seven-day janitor removes only a clean worktree whose commits are reachable.'
const REVIEW_TEXT =
  'review_receipt confines verification to bun/bash under scripts and bun run typecheck with read-only sources. The report ends with REVIEW: CLEAN or REVIEW: FINDINGS <count>.'

export async function getPrompt(
  agentDefinitions: readonly AgentDefinition[],
  isCoordinator = false,
  allowedAgentTypes?: readonly string[],
  _offered?: ReadonlySet<string>,
  refusals?: ReadonlyMap<string, string>,
  swarmOn = false,
): Promise<string> {
  const visible =
    allowedAgentTypes !== undefined
      ? agentDefinitions.filter(agent => allowedAgentTypes.includes(agent.agentType))
      : agentDefinitions
  const listing = visible
    .map(agent => formatAgentLine(agent, refusals?.get(agent.agentType)))
    .join('\n')
  const rosterBlock = listing !== '' ? `${AGENT_ROSTER_HEAD}\n${listing}` : ''
  if (isCoordinator) return rosterBlock

  const executionBody = swarmOn ? `${EXECUTION_TEXT} ${SEATS_TALK_DIRECTLY}` : EXECUTION_TEXT
  const sections = [
    ...(rosterBlock !== '' ? [rosterBlock] : []),
    `## Execution\n${executionBody}`,
    `## Worktree cleanup\n${CLEANUP_TEXT}`,
    `## Review mode\n${REVIEW_TEXT}`,
  ]
  return sections.join('\n\n')
}
