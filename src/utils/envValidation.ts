import { logForDebugging } from './debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type EnvVarValidationResult = Unbuilt

export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  upperLimit: number,
): EnvVarValidationResult {
  return notBuilt('src/utils/envValidation.ts:10')
}

export function apiTimeoutMsOverride(
  raw: string | undefined = flagEnv('MERCURY_API_TIMEOUT_MS'),
): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}
