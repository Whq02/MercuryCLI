
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

export function getMaxBashTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const max = parsePositiveInteger(env.BASH_MAX_TIMEOUT_MS) ?? MAX_BASH_TIMEOUT_MS
  return Math.max(max, getDefaultBashTimeoutMs(env))
}
