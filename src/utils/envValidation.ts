import { logForDebugging } from './debug.js'

/**
 * Validation for a bounded positive-integer environment variable with a
 * default and a ceiling.
 */
export type EnvVarValidationResult = {
  effective: number
  status: 'valid' | 'capped' | 'invalid'
  message?: string
}

export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  upperLimit: number,
): EnvVarValidationResult {
  if (value === undefined || value === '') {
    return { effective: defaultValue, status: 'valid' }
  }
  // STRICT whole-number parse (FC-047), the apiTimeoutMsOverride law below
  // applied to the limits family: parseInt's prefix leniency read `1e6` as
  // a 1-character limit and `12abc` as 12 while the doctor row reported ok.
  // A junk value is rejected WHOLE and falls to the default; `1e6` now
  // parses as the integer it names (then caps at the ceiling like any
  // large value).
  const parsed = Number(value.trim())
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const message = `invalid value "${value}"; using the default of ${defaultValue}`
    logForDebugging(`${name} ${message}`)
    return { effective: defaultValue, status: 'invalid', message }
  }
  if (parsed > upperLimit) {
    const message = `value ${parsed} exceeds the maximum of ${upperLimit}; capping to ${upperLimit}`
    logForDebugging(`${name} ${message}`)
    return { effective: upperLimit, status: 'capped', message }
  }
  return { effective: parsed, status: 'valid' }
}

/** API_TIMEOUT_MS — the ONE reader (TASK-017 S2,
 *  api-timeout-ms-three-parsers-no-floor). Three sites parsed this knob
 *  three ways: parseInt read '60s' as 60 (a 60-MILLISECOND transport that
 *  killed every turn while the error panel echoed '60sms, try increasing
 *  it'), Number() elsewhere fell back to the default on the same text, and
 *  no site enforced > 0. One strict contract now: a whole POSITIVE number
 *  of milliseconds, or null (callers apply their own default) — a unit
 *  suffix is rejected WHOLE, never truncated into milliseconds.
 *  Injectable raw value for the prover. */
export function apiTimeoutMsOverride(
  raw: string | undefined = process.env.API_TIMEOUT_MS,
): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}
