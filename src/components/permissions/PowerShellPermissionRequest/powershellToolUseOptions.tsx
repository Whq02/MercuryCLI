import { Text } from '../../../ink.js'
import { POWERSHELL_TOOL_NAME } from '../../../tools/PowerShellTool/toolName.js'
import type { PermissionUpdate } from '../../../types/permissions.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js'

export type PowerShellToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-edited-prefix' | 'no'

type Row = OptionWithDescription<PowerShellToolUseOption>

type AmendableRole = Extract<PowerShellToolUseOption, 'yes' | 'no'>

const AMENDABLE_WORDS: Record<AmendableRole, { label: string; placeholder: string }> = {
  yes: { label: 'Yes', placeholder: 'tell Mercury what to do next' },
  no: { label: 'No, and tell Mercury what to do differently (esc)', placeholder: 'tell Mercury what to do differently' },
}

function amendableRow(role: AmendableRole, open: boolean | undefined, onChange: (text: string) => void): Row {
  const { label, placeholder } = AMENDABLE_WORDS[role]
  return open ? { type: 'input', label, value: role, onChange, placeholder, allowEmptySubmitToCancel: true } : { label, value: role }
}

const onlyPowerShellRules = (suggestions: PermissionUpdate[]): boolean =>
  suggestions.every(update => update.type === 'addRules' && update.rules.every(rule => rule.toolName === POWERSHELL_TOOL_NAME))

function editedPrefixRow(initialValue: string, onChange: (prefix: string) => void): Row {
  return {
    type: 'input',
    label: "Yes, and don't ask again for commands starting with",
    value: 'yes-edited-prefix',
    initialValue,
    onChange,
    placeholder: 'Get-Process *',
    showLabelWithValue: true,
    labelValueSeparator: ': ',
    resetCursorOnUpdate: true,
  }
}

function applySuggestionsRow(suggestions: PermissionUpdate[]): Row | null {
  const label = generateShellSuggestionsLabel(suggestions, POWERSHELL_TOOL_NAME)
  return label === null ? null : { label: <Text>{label}</Text>, value: 'yes-apply-suggestions' }
}

function alwaysAllowRow(
  suggestions: PermissionUpdate[] | undefined,
  editablePrefix: string | undefined,
  onEditablePrefixChange: ((prefix: string) => void) | undefined,
): Row | null {
  if (!suggestions?.length) return null
  const editable = onlyPowerShellRules(suggestions) && editablePrefix !== undefined && onEditablePrefixChange !== undefined
  return editable ? editedPrefixRow(editablePrefix, onEditablePrefixChange) : applySuggestionsRow(suggestions)
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
}): Row[] {
  const rows = [
    amendableRow('yes', yesInputMode, onAcceptFeedbackChange),
    alwaysAllowRow(suggestions, editablePrefix, onEditablePrefixChange),
    amendableRow('no', noInputMode, onRejectFeedbackChange),
  ]
  return rows.filter((row): row is Row => row !== null)
}
