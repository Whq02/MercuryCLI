import { MODEL_ALIASES } from './aliases.js'
import { enforceSubagentModelFloor } from './modelFloor.js'
import { getCanonicalName, parseUserSpecifiedModel, getRuntimeMainLoopModel } from './model.js'

const INHERIT = 'inherit'

export type AgentModelAlias = (typeof MODEL_ALIASES)[number] | typeof INHERIT

export const AGENT_MODEL_OPTIONS: readonly string[] = [...MODEL_ALIASES, INHERIT]

export function getDefaultSubagentModel(): string {
  return INHERIT
}


const TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'mythos'])

function familyToken(canonical: string): string | null {
  const match = canonical.match(/claude-(opus|sonnet|haiku|fable)/)
  return match ? match[1] : null
}

function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const lowered = alias.trim().toLowerCase()
  if (!TIER_ALIASES.has(lowered)) return false
  const parentFamily = familyToken(getCanonicalName(parentModel))
  const aliasFamily = familyToken(getCanonicalName(parseUserSpecifiedModel(lowered)))
  return parentFamily !== null && parentFamily === aliasFamily
}


function resolveAgentModelRaw(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: string,
): string {
  if (toolSpecifiedModel !== undefined && toolSpecifiedModel !== '') {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) return parentModel
    return parseUserSpecifiedModel(toolSpecifiedModel)
  }

  const declared = agentModel ?? INHERIT
  if (declared === INHERIT) {
    return getRuntimeMainLoopModel({
      mainLoopModel: parentModel,
      permissionMode,
    })
  }

  if (aliasMatchesParentTier(declared, parentModel)) return parentModel
  return parseUserSpecifiedModel(declared)
}

export function getAgentModelWithFloorNote(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: string,
): { model: string; flooredFrom?: string } {
  const raw = resolveAgentModelRaw(agentModel, parentModel, toolSpecifiedModel, permissionMode)
  const floored = enforceSubagentModelFloor(raw, 'getAgentModel')
  return floored === raw ? { model: floored } : { model: floored, flooredFrom: raw }
}

export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: string,
): string {
  return getAgentModelWithFloorNote(agentModel, parentModel, toolSpecifiedModel, permissionMode).model
}


function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

export function getAgentModelDisplay(model: string | undefined | null): string {
  if (model === undefined || model === null) return 'Inherit from parent (default)'
  if (model === INHERIT) return 'Inherit from parent'
  return capitalizeFirst(model)
}
