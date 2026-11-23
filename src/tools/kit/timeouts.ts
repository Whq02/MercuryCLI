import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

const DEFAULT_BASH_TIMEOUT_MS = 120_000
const MAX_BASH_TIMEOUT_MS = 600_000

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value.trim())
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function getDefaultBashTimeoutMs(env: NodeJS.ProcessEnv = hostEnv()): number {
  return parsePositiveInteger(flagEnv('MERCURY_SHELL_TIMEOUT_MS', env)) ?? DEFAULT_BASH_TIMEOUT_MS
}

export function getMaxBashTimeoutMs(env: NodeJS.ProcessEnv = hostEnv()): number {
  const max = parsePositiveInteger(flagEnv('MERCURY_SHELL_MAX_TIMEOUT_MS', env)) ?? MAX_BASH_TIMEOUT_MS
  return Math.max(max, getDefaultBashTimeoutMs(env))
}
