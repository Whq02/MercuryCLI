import { subagentDefaultModel } from '../../utils/agentDefaults.js'

import { classifyModelRoute } from '../providers/idSpaces.js'
import { FIRST_PARTY_FAMILY_WORDS, routeOfFamilyWord } from './modelFamilies.js'
import { getCanonicalName, parseUserSpecifiedModel } from './model.js'

const INHERIT = 'inherit'

export function getDefaultSubagentModel(): string {
  return INHERIT
}


const FIRST_PARTY_TIER_WORDS = new Set([...FIRST_PARTY_FAMILY_WORDS, 'mythos'])

function firstPartyFamilyToken(canonical: string): string | null {
  const match = canonical.match(/claude-(?:3-\d+-)?(opus|sonnet|haiku|fable)/)
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

function resolveModelWord(word: string, parentModel: string): string {
  if (wordNamesParentFamily(word, parentModel)) {
    return parentModel
  }
  return parseUserSpecifiedModel(word)
}

export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
): string {
  if (toolSpecifiedModel) {
    return resolveModelWord(toolSpecifiedModel, parentModel)
  }
  const declared = agentModel ?? subagentDefaultModel() ?? INHERIT
  if (declared === INHERIT) {
    return parentModel
  }
  return resolveModelWord(declared, parentModel)
}
