import { EFFORT_LEVELS } from '../../entrypoints/sdk/runtimeTypes.js'
import type { EffortValue } from '../effort.js'

export const SEAT_EFFORTS: readonly string[] = EFFORT_LEVELS

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
