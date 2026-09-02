import { validateBoundedIntEnvVar } from '../envValidation.js'

export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000
export const BASH_MAX_OUTPUT_DEFAULT = 30_000
/** An output past the cap keeps its head AND its tail around one middle
 *  notice; this is the head's share of the budget — one owner for both
 *  sinks (the in-memory format and the spilled-file read). */
export const OUTPUT_HEAD_SHARE = 0.6

export function getMaxOutputLength(): number {
  const result = validateBoundedIntEnvVar(
    'BASH_MAX_OUTPUT_LENGTH',
    process.env.BASH_MAX_OUTPUT_LENGTH,
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}
