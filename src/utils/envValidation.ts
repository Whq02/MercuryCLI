import { logForDebugging } from './debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'

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

export function apiTimeoutMsOverride(
  raw: string | undefined = flagEnv('MERCURY_API_TIMEOUT_MS'),
): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}
