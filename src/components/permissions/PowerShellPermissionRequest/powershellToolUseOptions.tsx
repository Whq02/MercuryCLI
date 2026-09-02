import * as React from 'react'
import { Text } from '../../../ink.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { POWERSHELL_TOOL_NAME } from '../../../tools/PowerShellTool/toolName.js'
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js'
import type { PermissionUpdate } from '../../../types/permissions.js'

export type PowerShellToolUseOption =
  | 'yes'
  | 'yes-apply-suggestions'
  | 'yes-edited-prefix'
  | 'no'

/**
 * Whether the editable prefix input can represent these suggestions: any
 * directory addition, or any rule for a tool other than PowerShell, cannot
 * be expressed as a single PowerShell prefix rule.
 */
function editableCanRepresent(suggestions: PermissionUpdate[]): boolean {
  return suggestions.every(
    update =>
      update.type === 'addRules' &&
      update.rules.every(rule => rule.toolName === POWERSHELL_TOOL_NAME),
  )
}

export function powershellToolUseOptions({
  suggestions,
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode,
  noInputMode,
  editablePrefix,
  onEditablePrefixChange,
}: {
  suggestions?: PermissionUpdate[]
  onRejectFeedbackChange: (feedback: string) => void
  onAcceptFeedbackChange: (feedback: string) => void
  yesInputMode?: boolean
  noInputMode?: boolean
  editablePrefix?: string
  onEditablePrefixChange?: (prefix: string) => void
}): OptionWithDescription<PowerShellToolUseOption>[] {
  const options: OptionWithDescription<PowerShellToolUseOption>[] = []

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

  // At most one always-allow slot: the editable prefix input when the
  // suggestions can be represented as a single PowerShell prefix rule, the
  // non-editable apply-suggestions option otherwise (and none at all when
  // its label builder finds nothing to describe). PowerShell passes no
  // command transform.
  if (suggestions && suggestions.length > 0) {
    if (
      editableCanRepresent(suggestions) &&
      editablePrefix !== undefined &&
      onEditablePrefixChange
    ) {
      options.push({
        type: 'input',
        label: "Yes, and don't ask again for commands starting with",
        value: 'yes-edited-prefix',
        initialValue: editablePrefix,
        onChange: onEditablePrefixChange,
        placeholder: 'Get-Process:*',
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true,
      })
    } else {
      const label = generateShellSuggestionsLabel(suggestions, POWERSHELL_TOOL_NAME)
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
