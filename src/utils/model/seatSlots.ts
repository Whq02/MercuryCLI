// ============================================================================
//  seatSlots — the validated model + effort vocabulary for a daemon-hosted
//  seat (a crew spawn spec; the route kernel's Anthropic provider).
//
//  Every seat model is validated against the ALLOWED seat families
//  (opus-4-x / opus-5 / sonnet-5 / fable-5; mythos folds to fable) — never
//  Haiku — plus EXPLICIT exact gpt ids (the pure grammar parses them; LIVE
//  qualification is the dispatch runtime's law). Invalid values FAIL CLOSED
//  to the caller's fallback with an honest note (never to nothing, never to
//  the raw junk).
//
//  Bun-loadability: imports model.js + modelFloor.js and the pure gpt
//  grammar (zero imports). The local SEAT_EFFORTS vocabulary stays
//  cross-checked against effort.ts EFFORT_LEVELS by the proof suite.
// ============================================================================
import type { EffortValue } from '../effort.js'
import { getCanonicalName, parseUserSpecifiedModel } from './model.js'
import { isHaikuTier } from './modelFloor.js'
import { parseGptModelId } from '../../services/providers/openai/gptPins.js'

/**
 * CANONICAL model families a seat may run on (getCanonicalName folds ids to
 * these): 'claude-opus-4-6' is the canonical for the WHOLE Opus 4.x line —
 * opus-4-8 AND opus-4-7/4-6 fold there (model.ts:318-329), which deliberately
 * honors the standing "an earlier Opus can be restored without a rebuild"
 * swappability requirement; 'claude-opus-5' is its OWN canonical (the
 * current-generation ids never fold). Mythos is allowed implicitly (folds →
 * claude-fable-5). Haiku is refused before this list is consulted.
 */
export const SEAT_ALLOWED_FAMILIES: readonly string[] = [
  'claude-opus-4-6',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  // Claude Fable 5.1 keeps its own canonical (model.ts canonicalMatch) —
  // the frontier family's second member, allowed on the same terms.
  'claude-fable-5-1',
]

/** Mirrors effort.ts EFFORT_LEVELS (value-import is not bun-loadable there);
 *  the proof suite cross-checks this against the effort.ts source text. */
export const SEAT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Validate a raw operator-supplied model string against the seat allowlist.
 * - empty/undefined ⇒ fallback, silently (unset means "use the default")
 * - haiku tier (any spelling) ⇒ fallback + note (the never-Haiku rule)
 * - bare 'sonnet' resolves through the tier owner like any alias — on
 *   firstParty that is claude-sonnet-5 (an allowed family) since the catalog
 *   took the sonnet default; a 3P resolution to 4.5 still refuses off-list.
 * - an EXACT gpt id: accepted when the id parses under the PURE grammar —
 *   LIVE qualification stays the dispatch runtime's law, which refuses an
 *   unqualified id honestly at dispatch (never here from a remembered
 *   fact). The 'gpt'/'glm' class aliases and GLM ids never slot.
 * - off-list/junk ⇒ fallback + note
 * - allowed family ⇒ the RESOLVED id (aliases like 'fable'/'sonnet5' work)
 * FAIL CLOSED: the fallback is always the caller's pinned default, never the
 * input.
 */
export function validateSeatModel(
  raw: string | undefined,
  fallback: string,
): { model: string; note?: string } {
  const trimmed = raw?.trim()
  if (!trimmed) return { model: fallback }
  if (isHaikuTier(trimmed)) {
    return {
      model: fallback,
      note: `'${trimmed}' is Haiku-tier — never allowed for a seat; using '${fallback}'`,
    }
  }
  const gptIdentity = parseGptModelId(trimmed)
  if (gptIdentity) {
    return { model: gptIdentity.canonicalId }
  }
  const resolved = parseUserSpecifiedModel(trimmed)
  if (isHaikuTier(resolved)) {
    return {
      model: fallback,
      note: `'${trimmed}' resolves Haiku-tier — never allowed for a seat; using '${fallback}'`,
    }
  }
  const canonical = getCanonicalName(resolved)
  if (SEAT_ALLOWED_FAMILIES.includes(canonical)) {
    return { model: resolved }
  }
  return {
    model: fallback,
    note: `'${trimmed}' (→ ${canonical}) is not an allowed seat family [${SEAT_ALLOWED_FAMILIES.join(', ')}]; using '${fallback}'`,
  }
}

/** Validate a raw effort token; invalid ⇒ fallback + note. */
export function validateSeatEffort(
  raw: string | undefined,
  fallback: EffortValue,
): { effort: EffortValue; note?: string } {
  const trimmed = raw?.trim().toLowerCase()
  if (!trimmed) return { effort: fallback }
  if (SEAT_EFFORTS.includes(trimmed)) return { effort: trimmed as EffortValue }
  return {
    effort: fallback,
    note: `'${trimmed}' is not an effort level [${SEAT_EFFORTS.join(', ')}]; using '${String(fallback)}'`,
  }
}
