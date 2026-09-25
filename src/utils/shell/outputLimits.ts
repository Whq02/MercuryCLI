import { validateBoundedIntEnvVar } from '../envValidation.js'

export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000
export const BASH_MAX_OUTPUT_DEFAULT = 30_000
export const OUTPUT_HEAD_SHARE = 0.6

export const BASH_MAX_OUTPUT_FLOOR = 512

export type OutputBudget = { effective: number; requested?: number; clampedTo?: 'maximum' | 'minimum' }

export function getMaxOutputLength(): number {
  const result = validateBoundedIntEnvVar(
    'BASH_MAX_OUTPUT_LENGTH',
    process.env.BASH_MAX_OUTPUT_LENGTH,
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}

export function getMinOutputLength(): number {
  return Math.min(BASH_MAX_OUTPUT_FLOOR, getMaxOutputLength())
}

export function resolveOutputBudget(requested: number | string | undefined): OutputBudget {
  const cap = getMaxOutputLength()
  const asked = typeof requested === 'string' && /^\d+$/.test(requested.trim()) ? Number(requested) : requested
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return { effective: cap }
  const wanted = Math.floor(asked)
  const floor = getMinOutputLength()
  if (wanted > cap) return { effective: cap, requested: wanted, clampedTo: 'maximum' }
  if (wanted < floor) return { effective: floor, requested: wanted, clampedTo: 'minimum' }
  return { effective: wanted, requested: wanted }
}
