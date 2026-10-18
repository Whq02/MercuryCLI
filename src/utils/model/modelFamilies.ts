import { isProviderDisabled } from '../../services/providers/disabledProviders.js'
import { PROVIDER_ID_SPACES, type CallModelRoute } from '../../services/providers/idSpaces.js'
import { FAMILY_GENERATIONS } from './configs.js'

export const FIRST_PARTY_FAMILY_WORDS: ReadonlySet<string> = new Set(Object.keys(FAMILY_GENERATIONS))

export function routeOfFamilyWord(word: string): CallModelRoute | null {
  const lowered = word.trim().toLowerCase()
  if (lowered === 'anthropic') return isProviderDisabled('anthropic') ? null : 'anthropic'
  for (const space of PROVIDER_ID_SPACES) {
    if (space.route === lowered || space.bareAliases?.includes(lowered) || (space.qualifiedPrefix !== undefined && space.qualifiedPrefix === `${lowered}/`)) {
      return isProviderDisabled(space.route) ? null : space.route
    }
  }
  return null
}

export function modelFamilyWords(): readonly string[] {
  const words: string[] = isProviderDisabled('anthropic') ? [] : ['anthropic', ...FIRST_PARTY_FAMILY_WORDS]
  for (const space of PROVIDER_ID_SPACES) {
    if (isProviderDisabled(space.route)) continue
    words.push(space.route)
    for (const alias of space.bareAliases ?? []) words.push(alias)
    if (space.qualifiedPrefix !== undefined) words.push(space.qualifiedPrefix.slice(0, -1))
  }
  return [...new Set(words)]
}

export function isModelFamilyWord(word: string): boolean {
  const lowered = word.trim().toLowerCase()
  return routeOfFamilyWord(lowered) !== null || (!isProviderDisabled('anthropic') && FIRST_PARTY_FAMILY_WORDS.has(lowered))
}
