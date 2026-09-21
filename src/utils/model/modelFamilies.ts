import { PROVIDER_ID_SPACES, type CallModelRoute } from '../../services/providers/idSpaces.js'
import { FAMILY_GENERATIONS } from './configs.js'

export const FIRST_PARTY_FAMILY_WORDS: ReadonlySet<string> = new Set(Object.keys(FAMILY_GENERATIONS))

export function routeOfFamilyWord(word: string): CallModelRoute | null {
  const lowered = word.trim().toLowerCase()
  if (lowered === 'anthropic') return 'anthropic'
  for (const space of PROVIDER_ID_SPACES) {
    if (space.route === lowered) return space.route
    if (space.bareAliases?.includes(lowered)) return space.route
    if (space.qualifiedPrefix !== undefined && space.qualifiedPrefix === `${lowered}/`) return space.route
  }
  return null
}

export function modelFamilyWords(): readonly string[] {
  const words: string[] = ['anthropic', ...FIRST_PARTY_FAMILY_WORDS]
  for (const space of PROVIDER_ID_SPACES) {
    words.push(space.route)
    for (const alias of space.bareAliases ?? []) words.push(alias)
    if (space.qualifiedPrefix !== undefined) words.push(space.qualifiedPrefix.slice(0, -1))
  }
  return [...new Set(words)]
}

export function isModelFamilyWord(word: string): boolean {
  const lowered = word.trim().toLowerCase()
  return routeOfFamilyWord(lowered) !== null || FIRST_PARTY_FAMILY_WORDS.has(lowered)
}
