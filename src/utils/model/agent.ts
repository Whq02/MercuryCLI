import { subagentDefaultModel } from '../agentDefaults.js'
import { MODEL_ALIASES } from './aliases.js'
import { classifyModelRoute } from '../../services/providers/idSpaces.js'
import { FIRST_PARTY_FAMILY_WORDS, routeOfFamilyWord } from './modelFamilies.js'
import { getCanonicalName, parseUserSpecifiedModel, getRuntimeMainLoopModel } from './model.js'

const INHERIT = 'inherit'

export type AgentModelAlias = (typeof MODEL_ALIASES)[number] | typeof INHERIT

export const AGENT_MODEL_OPTIONS: readonly string[] = [...MODEL_ALIASES, INHERIT]

export function getDefaultSubagentModel(): string {
  return INHERIT
}


const FIRST_PARTY_TIER_WORDS = new Set([...FIRST_PARTY_FAMILY_WORDS, 'mythos'])

function firstPartyFamilyToken(canonical: string): string | null {
  const match = canonical.match(/claude-(opus|sonnet|haiku|fable)/)
  return match ? match[1] : null
}

function wordNamesParentFamily(word: string, parentModel: string): boolean {
  const lowered = word.trim().toLowerCase()
  const parentVerdict = classifyModelRoute(parentModel)
  if (parentVerdict.kind !== 'route') return false
  const wordRoute = routeOfFamilyWord(lowered)
  if (wordRoute !== null) return wordRoute === parentVerdict.route
  if (!FIRST_PARTY_TIER_WORDS.has(lowered) || parentVerdict.route !== 'anthropic') return false
  const parentFamily = firstPartyFamilyToken(getCanonicalName(parentModel))
  const wordFamily = firstPartyFamilyToken(getCanonicalName(parseUserSpecifiedModel(lowered)))
  return parentFamily !== null && parentFamily === wordFamily
}


export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: string,
): string {
  if (toolSpecifiedModel !== undefined && toolSpecifiedModel !== '') {
    if (wordNamesParentFamily(toolSpecifiedModel, parentModel)) return parentModel
    return parseUserSpecifiedModel(toolSpecifiedModel)
  }

  if (agentModel === undefined) {
    const configured = subagentDefaultModel()
    if (configured !== undefined) {
      if (wordNamesParentFamily(configured, parentModel)) return parentModel
      return parseUserSpecifiedModel(configured)
    }
  }

  const declared = agentModel ?? INHERIT
  if (declared === INHERIT) {
    return getRuntimeMainLoopModel({
      mainLoopModel: parentModel,
      permissionMode,
    })
  }

  if (wordNamesParentFamily(declared, parentModel)) return parentModel
  return parseUserSpecifiedModel(declared)
}


function capitalizeFirst(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

export function getAgentModelDisplay(model: string | undefined | null): string {
  if (model === undefined || model === null) return 'Inherit from parent (default)'
  if (model === INHERIT) return 'Inherit from parent'
  return capitalizeFirst(model)
}
