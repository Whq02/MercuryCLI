
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Skill',
  'Brief',
  'ExitStrategyMode',
  'EnterStrategyMode',
])

const SKILL_PATH_MARKS = ['mercury-skills/', '/skills/'] as const

function normalizedReadPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export const PLACEHOLDER_COST_FLOOR_TOKENS = 48

export function isProtectedFromPruning(
  toolName: string | undefined,
  input?: unknown,
): boolean {
  if (toolName === undefined) return false
  if (PROTECTED_TOOL_NAMES.has(toolName)) return true
  if (toolName === 'Read' || toolName === 'FileRead') {
    const path = (input as { file_path?: unknown } | undefined)?.file_path
    if (typeof path === 'string') {
      const normalized = normalizedReadPath(path)
      if (SKILL_PATH_MARKS.some(mark => normalized.includes(mark))) return true
    }
  }
  return false
}

export function isBelowPlaceholderFloor(estimatedTokens: number): boolean {
  return estimatedTokens <= PLACEHOLDER_COST_FLOOR_TOKENS
}
