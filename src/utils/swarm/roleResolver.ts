// ============================================================================
//  roleResolver — ONE resolver for teammate roles, fed into EVERY launch
//  backend. Before this module, each spawn path resolved
//  roles its own way: the in-process path kept only CUSTOM definitions (a
//  built-in Mercury role silently lost its prompt/tools/model), the pane path
//  skipped built-in prompts entirely, and the runner substituted the
//  teammate's display name for its role identity. Every path now resolves
//  through here, so a 'mercury-scout' teammate is the same agent no matter
//  how it was launched.
// ============================================================================

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

/** Decode a requested agent type to its canonical registered id (legacy
 *  aliases keep resolving; new surfaces always emit the canonical id). */
export function decodeAgentType(requested: string): string
export function decodeAgentType(requested: string | undefined): string | undefined
export function decodeAgentType(requested: string | undefined): string | undefined {
  if (!requested) return undefined
  return LEGACY_SUBAGENT_ALIASES[requested] ?? requested
}

/** Find the registered definition for an agent type — built-in, custom, or
 *  extension alike (the in-process path would otherwise keep only custom ones). */
export function findRoleDefinition(
  requested: string | undefined,
  agents: readonly AgentDefinition[],
): AgentDefinition | undefined {
  const canonical = decodeAgentType(requested)
  if (!canonical) return undefined
  return agents.find(a => a.agentType === canonical)
}

/**
 * The role's system-prompt contribution, normalized across definition kinds.
 * Built-ins compose with the live tool context when one exists; the few whose
 * builders genuinely need it (mercury-guide) resolve to undefined without one
 * — an honest skip, never a fabricated prompt.
 */
export function getRoleSystemPrompt(
  def: AgentDefinition,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
): string | undefined {
  try {
    if (isBuiltInAgent(def)) {
      if (toolUseContext) {
        return def.getSystemPrompt({ toolUseContext })
      }
      // Most built-in role prompts are static and ignore the param; the ones
      // that destructure it throw here and resolve to undefined.
      return (def.getSystemPrompt as (p?: unknown) => string)(undefined)
    }
    return def.getSystemPrompt()
  } catch {
    return undefined
  }
}

/** Derive a compact role packet from what the spawn actually knows. Thin but
 *  honest — richer fields arrive when the lead states them; nothing is
 *  invented. */
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

/** The normalized product every launch backend consumes. */
export type ResolvedTeammateRole = {
  /** Canonical role id (legacy aliases decoded); the display name never
   *  substitutes for this. */
  agentType: string
  displayLabel: string
  definition?: AgentDefinition
  /** Role tool contract (undefined ⇒ all tools). */
  tools?: readonly string[]
  /** Role tool denials (e.g. the scout's write-tool bar). */
  disallowedTools?: readonly string[]
  /** Role model pin from the definition, if any. */
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
