
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { TEAM_BRIEF_TOOL_NAME } from '../../tools/TeamBriefTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/constants.js'

export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Skill',
  'Brief',
  'ExitStrategyMode',
  'EnterStrategyMode',
  ASK_USER_QUESTION_TOOL_NAME,
  TEAM_BRIEF_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
])

export const PROTECT_NEWEST_TOOL_OUTPUT_TOKENS = 40_000

export const PRUNE_MINIMUM_SAVING_TOKENS = 20_000

const SKILL_PATH_MARKS = ['mercury-skills/', '/skills/'] as const

function normalizedReadPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

export const PLACEHOLDER_COST_FLOOR_TOKENS = 50

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
