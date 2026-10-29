
const DEFAULT_BASH_TIMEOUT_MS = 120_000
const MAX_BASH_TIMEOUT_MS = 600_000

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value.trim())
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function getDefaultBashTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(env.MERCURY_SHELL_TIMEOUT_MS) ?? DEFAULT_BASH_TIMEOUT_MS
}

export function getMaxBashTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const max = parsePositiveInteger(env.MERCURY_SHELL_MAX_TIMEOUT_MS) ?? MAX_BASH_TIMEOUT_MS
  return Math.max(max, getDefaultBashTimeoutMs(env))
}
