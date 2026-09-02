/**
 * `availableModels` allowlist matching (family / version-prefix / exact).
 *
 * Absent → everything allowed; present but empty → nothing user-specified is
 * allowed.
 */
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAlias, isModelFamilyAlias, MODEL_FAMILY_ALIASES } from './aliases.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'

const VENDOR_PREFIX = 'claude-'
const CONTEXT_SUFFIX_RE = /\[[0-9]+m\]$/i

/** Trim, lowercase, strip a trailing `[Nm]` context suffix (end-anchored). */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(CONTEXT_SUFFIX_RE, '')
}

/** "More specific entry for a family": a CONTAINMENT test with a boundary —
 *  a non-family-alias entry counts when it contains the family name
 *  immediately followed by a dash or the end of the string (so a full model
 *  ID, vendor prefix and all, narrows the family wildcard too). */
function hasMoreSpecificEntry(family: string, entries: string[]): boolean {
  return entries.some(
    entry =>
      !isModelFamilyAlias(entry) &&
      (entry.includes(`${family}-`) || entry.endsWith(family)),
  )
}

export function isModelAllowed(model: string): boolean {
  const raw = getSettings_DEPRECATED().availableModels
  if (raw === undefined) return true // absent ⇒ everything allowed
  if (!Array.isArray(raw) || raw.length === 0) return false // empty ⇒ nothing

  const entries = raw.map(entry => normalize(String(entry)))
  const candidate = normalize(resolveOverriddenModel(model))
  const candidateResolved = isModelAlias(candidate)
    ? normalize(parseUserSpecifiedModel(candidate))
    : candidate

  // Tier 1: direct equality — but a bare family alias matching directly is
  // ignored when a more specific entry for that family exists (fall-through).
  for (const entry of entries) {
    if (entry !== candidate) continue
    if (isModelFamilyAlias(candidate) && hasMoreSpecificEntry(candidate, entries)) break
    return true
  }

  // Tier 2: family wildcard — a family alias in the list admits any model of
  // that family, when no more specific entry exists.
  for (const family of MODEL_FAMILY_ALIASES) {
    if (!entries.includes(family)) continue
    if (hasMoreSpecificEntry(family, entries)) continue
    const target = isModelAlias(candidate) ? candidateResolved : candidate
    if (target.includes(family)) return true
  }

  // Tier 3: alias resolution, both directions.
  for (const entry of entries) {
    // A candidate alias whose resolution is listed.
    if (isModelAlias(candidate) && candidateResolved === entry) return true
    // A listed alias that is not a family alias whose resolution equals the
    // candidate.
    if (isModelAlias(entry) && !isModelFamilyAlias(entry)) {
      if (normalize(parseUserSpecifiedModel(entry)) === candidate) return true
    }
  }

  // Tier 4: version-prefix match, only for entries that are neither family
  // aliases nor known aliases. Segment-boundary anchored; tried as written
  // and, when it lacks the vendor prefix, with it prepended.
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
