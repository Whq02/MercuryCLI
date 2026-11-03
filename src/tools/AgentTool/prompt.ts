
import { MERCURY_SCOUT_AGENT_TYPE } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
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
  isCoordinator = false,
  allowedAgentTypes?: readonly string[],
  offered?: ReadonlySet<string>,
  refusals?: ReadonlyMap<string, string>,
): Promise<string> {
  void offered
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(agent => allowedAgentTypes.includes(agent.agentType))
    : agentDefinitions
  const listing = effectiveAgents.map(agent => formatAgentLine(agent, refusals?.get(agent.agentType))).join('\n')
  const sections: string[] = listing ? [`${AGENT_ROSTER_HEAD}\n${listing}`] : []
  if (isCoordinator) return sections.join('\n\n')

  sections.push(`## Execution
Launches in one message overlap; separate messages run serially. Foreground calls wait for the report. Reports return to the caller, not directly to the user.

Tool access follows the selected agent definition and the session's permissions. Foreground and background launches have the same tool access.

With swarm on, a new crewmate is enrolled on the live crew board and told its name, its team and the seats already there. Posts arrive as [name] [team] [kind] rows between turns.`)

  sections.push(`## Worktree cleanup
The seven-day janitor removes only a clean worktree whose commits are reachable.`)

  sections.push(`## Review mode
A review receipt confines verification to bun/bash commands under scripts and bun run typecheck with sources read-only. The report ends with REVIEW: CLEAN or REVIEW: FINDINGS <count>.`)

  return sections.join('\n\n')
}
