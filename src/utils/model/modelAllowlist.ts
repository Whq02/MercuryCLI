import { getSettings_DEPRECATED } from '../settings/settings.js'
import { classifyModelRoute } from '../../services/providers/idSpaces.js'
import { isModelAlias } from './aliases.js'
import { FIRST_PARTY_FAMILY_WORDS, isModelFamilyWord, routeOfFamilyWord } from './modelFamilies.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'

const VENDOR_PREFIX = 'claude-'
const CONTEXT_SUFFIX_RE = /\[[0-9]+m\]$/i

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(CONTEXT_SUFFIX_RE, '')
}

function resolvedOf(value: string): string {
  return isModelAlias(value) ? normalize(parseUserSpecifiedModel(value)) : value
}

function inFamily(word: string, resolved: string): boolean {
  const route = routeOfFamilyWord(word)
  const verdict = classifyModelRoute(resolved)
  if (route !== null) return verdict.kind === 'route' && verdict.route === route
  if (!FIRST_PARTY_FAMILY_WORDS.has(word)) return false
  return verdict.kind === 'route' && verdict.route === 'anthropic' && resolved.includes(word)
}

function hasMoreSpecificEntry(word: string, entries: string[]): boolean {
  return entries.some(entry => {
    if (isModelFamilyWord(entry)) return false
    if (inFamily(word, resolvedOf(entry))) return true
    return FIRST_PARTY_FAMILY_WORDS.has(word) && (entry.includes(`${word}-`) || entry.endsWith(word))
  })
}

export function isModelAllowed(model: string): boolean {
  const raw = getSettings_DEPRECATED().availableModels
  if (raw === undefined) return true
  if (!Array.isArray(raw) || raw.length === 0) return false

  const entries = raw.map(entry => normalize(String(entry)))
  const candidate = normalize(resolveOverriddenModel(model))
  const candidateResolved = resolvedOf(candidate)

  for (const entry of entries) {
    if (entry !== candidate) continue
    if (isModelFamilyWord(candidate) && hasMoreSpecificEntry(candidate, entries)) break
    return true
  }

  for (const entry of entries) {
    if (!isModelFamilyWord(entry)) continue
    if (hasMoreSpecificEntry(entry, entries)) continue
    if (inFamily(entry, candidateResolved)) return true
  }

  for (const entry of entries) {
    if (isModelAlias(candidate) && candidateResolved === entry) return true
    if (isModelAlias(entry) && !isModelFamilyWord(entry)) {
      if (normalize(parseUserSpecifiedModel(entry)) === candidate) return true
    }
  }

  const prefixMatches = (prefix: string): boolean =>
    candidateResolved === prefix || candidateResolved.startsWith(`${prefix}-`)
  for (const entry of entries) {
    if (isModelFamilyWord(entry) || isModelAlias(entry)) continue
    if (prefixMatches(entry)) return true
    if (!entry.startsWith(VENDOR_PREFIX) && prefixMatches(`${VENDOR_PREFIX}${entry}`)) return true
  }

  return false
}
