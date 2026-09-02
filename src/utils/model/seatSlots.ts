import type { EffortValue } from '../effort.js'
import { getCanonicalName, parseUserSpecifiedModel } from './model.js'
import { isHaikuTier } from './modelFloor.js'
import { parseGptModelId } from '../../services/providers/openai/gptPins.js'

export const SEAT_ALLOWED_FAMILIES: readonly string[] = [
  'claude-opus-4-6',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
]

export const SEAT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
