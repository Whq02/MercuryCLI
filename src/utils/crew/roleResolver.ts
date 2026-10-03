
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  MERCURY_BEHAVIOR_PROFILE,
  type MercuryBehaviorProfile,
} from '../profile/mercuryProfile.js'
import {
  CREW_CHARTER_VERSION,
  type CrewCharter,
  type CrewRolePacket,
} from './crewCharter.js'
import { CREW_LEAD_NAME } from './constants.js'

export function findRoleDefinition(
  requested: string | undefined,
  agents: readonly AgentDefinition[],
): AgentDefinition | undefined {
  if (!requested) return undefined
  return agents.find(a => a.agentType === requested)
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

export type CrewmateRoleRecord = {
  id: string
  name: string
  kind: 'crewmate' | 'seat'
  model?: string | null
  cwd?: string | null
  worktree?: string | null
}

function ownedByCrewmate(crewmate: CrewmateRoleRecord | undefined): string[] {
  if (!crewmate) return []
  const tree = crewmate.worktree ?? crewmate.cwd
  return tree ? [tree] : []
}

export function deriveRolePacket(i: {
  crewmateName?: string
  crewmate?: CrewmateRoleRecord
  agentType: string
  prompt: string
  description?: string
  charter?: CrewCharter | null
}): CrewRolePacket {
  const firstLine = i.prompt.split('\n', 1)[0] ?? ''
  const mission =
    i.description?.trim() ||
    (firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine) ||
    'as assigned by the lead'
  return {
    crewmateName: i.crewmate?.name ?? i.crewmateName ?? '',
    agentType: i.agentType,
    mission,
    owns: ownedByCrewmate(i.crewmate),
    dependsOn: [],
    deliverable: 'what your task message specifies, with evidence',
    doneWhen: [],
    handoffTo: i.charter?.synthesisOwner ?? CREW_LEAD_NAME,
    charterVersion: CREW_CHARTER_VERSION,
  }
}

export type ResolvedCrewmateRole = {
  agentType: string
  displayLabel: string
  definition?: AgentDefinition
  tools?: readonly string[]
  disallowedTools?: readonly string[]
  model?: string
  behavior: MercuryBehaviorProfile
  charter?: CrewCharter | null
  rolePacket: CrewRolePacket
}

export function resolveCrewmateRole(i: {
  crewmateName?: string
  crewmate?: CrewmateRoleRecord
  requestedAgentType?: string
  agents: readonly AgentDefinition[]
  prompt: string
  description?: string
  charter?: CrewCharter | null
}): ResolvedCrewmateRole {
  const definition = findRoleDefinition(i.requestedAgentType, i.agents)
  const crewmateName = i.crewmate?.name ?? i.crewmateName ?? ''
  const agentType =
    definition?.agentType ?? (i.requestedAgentType || undefined) ?? crewmateName
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
      crewmateName: crewmateName,
      crewmate: i.crewmate,
      agentType,
      prompt: i.prompt,
      description: i.description,
      charter: i.charter,
    }),
  }
}
