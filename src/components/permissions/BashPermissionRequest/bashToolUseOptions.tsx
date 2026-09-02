import * as React from 'react'
import { Text } from '../../../ink.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import { extractOutputRedirections } from '../../../utils/bash/commands.js'
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js'
import type { PermissionDecisionReason, PermissionUpdate } from '../../../types/permissions.js'

export type BashToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-edited-prefix' | 'no'

function stripRedirections(command: string): string {
  const extracted = extractOutputRedirections(command)
  return extracted.redirections.length > 0 ? extracted.commandWithoutRedirections : command
}

function editableCanRepresent(suggestions: PermissionUpdate[]): boolean {
  return suggestions.every(
    update =>
      update.type === 'addRules' && update.rules.every(rule => rule.toolName === BASH_TOOL_NAME),
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

export function bashToolUseOptions({
  suggestions,
  decisionReason,
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode,
  noInputMode,
  editablePrefix,
  onEditablePrefixChange,
}: {
  suggestions?: PermissionUpdate[]
  decisionReason?: PermissionDecisionReason
  onRejectFeedbackChange: (feedback: string) => void
  onAcceptFeedbackChange: (feedback: string) => void
  yesInputMode?: boolean
  noInputMode?: boolean
  editablePrefix?: string
  onEditablePrefixChange?: (prefix: string) => void
}): OptionWithDescription<BashToolUseOption>[] {
  const options: OptionWithDescription<BashToolUseOption>[] = []

  if (yesInputMode) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      onChange: onAcceptFeedbackChange,
      placeholder: 'tell Mercury what to do next',
      allowEmptySubmitToCancel: true,
    })
  } else {
    options.push({ label: 'Yes', value: 'yes' })
  }

  if (suggestions && suggestions.length > 0) {
    const compound = decisionReason?.type === 'subcommandResults'
    const editableAllowed =
      editableCanRepresent(suggestions) && (!compound || bashRuleCount(suggestions) === 1)
    if (editableAllowed && editablePrefix !== undefined && onEditablePrefixChange) {
      options.push({
        type: 'input',
        label: "Yes, and don't ask again for commands starting with",
        value: 'yes-edited-prefix',
        initialValue: editablePrefix,
        onChange: onEditablePrefixChange,
        placeholder: 'npm run:*',
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true,
      })
    } else {
      const label = generateShellSuggestionsLabel(suggestions, BASH_TOOL_NAME, stripRedirections)
      if (label !== null) {
        options.push({ label: <Text>{label}</Text>, value: 'yes-apply-suggestions' })
      }
    }
  }

  if (noInputMode) {
    options.push({
      type: 'input',
      label: 'No, and tell Mercury what to do differently (esc)',
      value: 'no',
      onChange: onRejectFeedbackChange,
      placeholder: 'tell Mercury what to do differently',
      allowEmptySubmitToCancel: true,
    })
  } else {
    options.push({ label: 'No, and tell Mercury what to do differently (esc)', value: 'no' })
  }

  return options
}
