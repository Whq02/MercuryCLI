import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAlias, isModelFamilyAlias, MODEL_FAMILY_ALIASES } from './aliases.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'

const VENDOR_PREFIX = 'claude-'
const CONTEXT_SUFFIX_RE = /\[[0-9]+m\]$/i

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(CONTEXT_SUFFIX_RE, '')
}

function hasMoreSpecificEntry(family: string, entries: string[]): boolean {
  return entries.some(
    entry =>
      !isModelFamilyAlias(entry) &&
      (entry.includes(`${family}-`) || entry.endsWith(family)),
  )
}

export function isModelAllowed(model: string): boolean {
  const raw = getSettings_DEPRECATED().availableModels
  if (raw === undefined) return true
  if (!Array.isArray(raw) || raw.length === 0) return false

  const entries = raw.map(entry => normalize(String(entry)))
  const candidate = normalize(resolveOverriddenModel(model))
  const candidateResolved = isModelAlias(candidate)
    ? normalize(parseUserSpecifiedModel(candidate))
    : candidate

  for (const entry of entries) {
    if (entry !== candidate) continue
    if (isModelFamilyAlias(candidate) && hasMoreSpecificEntry(candidate, entries)) break
    return true
  }

  for (const family of MODEL_FAMILY_ALIASES) {
    if (!entries.includes(family)) continue
    if (hasMoreSpecificEntry(family, entries)) continue
    const target = isModelAlias(candidate) ? candidateResolved : candidate
    if (target.includes(family)) return true
  }

  for (const entry of entries) {
    if (isModelAlias(candidate) && candidateResolved === entry) return true
    if (isModelAlias(entry) && !isModelFamilyAlias(entry)) {
      if (normalize(parseUserSpecifiedModel(entry)) === candidate) return true
    }
  }

  const target = isModelAlias(candidate) ? candidateResolved : candidate
  const prefixMatches = (prefix: string): boolean =>
    target === prefix || target.startsWith(`${prefix}-`)
  for (const entry of entries) {
    if (isModelFamilyAlias(entry) || isModelAlias(entry)) continue
    if (prefixMatches(entry)) return true
    if (!entry.startsWith(VENDOR_PREFIX) && prefixMatches(`${VENDOR_PREFIX}${entry}`)) return true
  }

  return false
}
