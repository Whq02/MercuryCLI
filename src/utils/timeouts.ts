/**
 * Default and maximum shell-command timeouts, environment-overridable.
 * Both take the environment map as a parameter so they are testable.
 */

const DEFAULT_BASH_TIMEOUT_MS = 120_000
const MAX_BASH_TIMEOUT_MS = 600_000

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return null
  return parsed
}

export function getDefaultBashTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_BASH_TIMEOUT_MS
}

/** Never below the resolved default, so a small override cannot invert the pair. */
export function getMaxBashTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const max = parsePositiveInteger(env.BASH_MAX_TIMEOUT_MS) ?? MAX_BASH_TIMEOUT_MS
  return Math.max(max, getDefaultBashTimeoutMs(env))
}
