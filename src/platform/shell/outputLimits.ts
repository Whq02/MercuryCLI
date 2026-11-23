import { flagEnv } from '../substrate/flagRegistry.js'
import { validateBoundedIntEnvVar } from '../environment/envValidation.js'

export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000
export const BASH_MAX_OUTPUT_DEFAULT = 30_000
export const OUTPUT_HEAD_SHARE = 0.6

export const BASH_MAX_OUTPUT_FLOOR = 512

export const SHELL_MAX_OUTPUT_ENV = 'MERCURY_SHELL_MAX_OUTPUT'

export type OutputBudget = { effective: number; requested?: number; clampedTo?: 'maximum' | 'minimum' }

export function getMaxOutputLength(): number {
  return validateBoundedIntEnvVar(
    SHELL_MAX_OUTPUT_ENV,
    flagEnv(SHELL_MAX_OUTPUT_ENV),
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  ).effective
}

export function getMinOutputLength(): number {
  return Math.min(BASH_MAX_OUTPUT_FLOOR, getMaxOutputLength())
}

export function resolveOutputBudget(requested: number | undefined): OutputBudget {
  const cap = getMaxOutputLength()
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return { effective: cap }
  const wanted = Math.floor(requested)
  const floor = getMinOutputLength()
  if (wanted > cap) return { effective: cap, requested: wanted, clampedTo: 'maximum' }
  if (wanted < floor) return { effective: floor, requested: wanted, clampedTo: 'minimum' }
  return { effective: wanted, requested: wanted }
}
