
import type { ToolUseContext } from '../../Tool.js'
import { LEGACY_SUBAGENT_ALIASES } from '../../tools/AgentTool/builtInAgents.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  MERCURY_BEHAVIOR_PROFILE,
  type MercuryBehaviorProfile,
} from '../profile/mercuryProfile.js'
import {
  TEAM_CHARTER_VERSION,
  type TeamCharter,
  type TeamRolePacket,
} from './teamCharter.js'
import { TEAM_LEAD_NAME } from './constants.js'

export function decodeAgentType(requested: string): string
export function decodeAgentType(requested: string | undefined): string | undefined
export function decodeAgentType(requested: string | undefined): string | undefined {
  if (!requested) return undefined
  return LEGACY_SUBAGENT_ALIASES[requested] ?? requested
}

export function findRoleDefinition(
  requested: string | undefined,
  agents: readonly AgentDefinition[],
): AgentDefinition | undefined {
  const canonical = decodeAgentType(requested)
  if (!canonical) return undefined
  return agents.find(a => a.agentType === canonical)
}

export function getRoleSystemPrompt(
  def: AgentDefinition,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
): string | undefined {
  try {
    if (isBuiltInAgent(def)) {
      if (toolUseContext) {
        return def.getSystemPrompt({ toolUseContext })
      }
      return (def.getSystemPrompt as (p?: unknown) => string)(undefined)
    }
    return def.getSystemPrompt()
  } catch {
    return undefined
  }
}

export function deriveRolePacket(i: {
  teammateName: string
  agentType: string
  prompt: string
  description?: string
  charter?: TeamCharter | null
}): TeamRolePacket {
  const firstLine = i.prompt.split('\n', 1)[0] ?? ''
  const mission =
    i.description?.trim() ||
    (firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine) ||
    'as assigned by the lead'
  return {
    teammateName: i.teammateName,
    agentType: i.agentType,
    mission,
    owns: [],
    dependsOn: [],
    deliverable: 'what your task message specifies, with evidence',
    doneWhen: [],
    handoffTo: i.charter?.synthesisOwner ?? TEAM_LEAD_NAME,
    charterVersion: TEAM_CHARTER_VERSION,
  }
}

export type ResolvedTeammateRole = {
  agentType: string
  displayLabel: string
  definition?: AgentDefinition
  tools?: readonly string[]
  disallowedTools?: readonly string[]
  model?: string
  behavior: MercuryBehaviorProfile
  charter?: TeamCharter | null
  rolePacket: TeamRolePacket
}

export function resolveTeammateRole(i: {
  teammateName: string
  requestedAgentType?: string
  agents: readonly AgentDefinition[]
  prompt: string
  description?: string
  charter?: TeamCharter | null
}): ResolvedTeammateRole {
  const definition = findRoleDefinition(i.requestedAgentType, i.agents)
  const agentType =
    definition?.agentType ?? decodeAgentType(i.requestedAgentType) ?? i.teammateName
  return {
    agentType,
    displayLabel: agentType,
    definition,
    tools: definition?.tools,
    disallowedTools: definition?.disallowedTools,
    model: definition?.model,
    behavior: MERCURY_BEHAVIOR_PROFILE,
    charter: i.charter ?? null,
    rolePacket: deriveRolePacket({
      teammateName: i.teammateName,
      agentType,
      prompt: i.prompt,
      description: i.description,
      charter: i.charter,
    }),
  }
}
