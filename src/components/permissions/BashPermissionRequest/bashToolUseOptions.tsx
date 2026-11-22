import { Text } from '../../../ink.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import { extractOutputRedirections } from '../../../utils/bash/commands.js'
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js'
import type { PermissionDecisionReason, PermissionUpdate } from '../../../types/permissions.js'
import { notBuilt } from '../../../pi/holes.js'

export type BashToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-edited-prefix' | 'no'

function stripRedirections(command: string): string {
  const extracted = extractOutputRedirections(command)
  return extracted.redirections.length > 0 ? extracted.commandWithoutRedirections : command
}

function editableCanRepresent(suggestions: PermissionUpdate[]): boolean {
  return (
    suggestions.some(
      update =>
        update.type === 'addRules' &&
        update.rules.some(rule => rule.toolName === BASH_TOOL_NAME && (rule.ruleContent ?? '').trim() !== ''),
    ) &&
    suggestions.every(
      update =>
        update.type === 'addRules' && update.rules.every(rule => rule.toolName === BASH_TOOL_NAME),
    )
  )
}

function bashRuleCount(suggestions: PermissionUpdate[]): number {
  let count = 0
  for (const update of suggestions) {
    if (update.type !== 'addRules') continue
    for (const rule of update.rules) {
      if (rule.toolName === BASH_TOOL_NAME && rule.ruleContent) count++
    }
  }
  return count
}

export function bashToolUseOptions(arg0: {
  suggestions?: PermissionUpdate[]
  decisionReason?: PermissionDecisionReason
  onRejectFeedbackChange: (feedback: string) => void
  onAcceptFeedbackChange: (feedback: string) => void
  yesInputMode?: boolean
  noInputMode?: boolean
  editablePrefix?: string
  onEditablePrefixChange?: (prefix: string) => void
}): OptionWithDescription<BashToolUseOption>[] {
  return notBuilt('src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx:40')
}
