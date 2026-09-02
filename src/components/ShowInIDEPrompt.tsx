// The IDE-diff permission surface: the changes were opened in the named IDE;
// warn on a symlink target (louder when it escapes the working directory);
// on the VS Code family, remind that saving the file continues; then the
// permission options. Reject / accept-once carry the trimmed feedback text.

import React from 'react'
import { relative } from 'path'
import { Box, Text } from '../ink.js'
import { getCwd } from '../utils/cwd.js'
import { isSupportedVSCodeTerminal } from '../utils/ide.js'
import { basename } from 'path'
import { Select } from './CustomSelect/select.js'
import type {
  PermissionOption,
  PermissionOptionWithLabel,
} from './permissions/FilePermissionDialog/permissionOptions.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

export function ShowInIDEPrompt<A>({
  filePath,
  input,
  onChange,
  options,
  ideName,
  symlinkTarget,
  acceptFeedback,
  rejectFeedback,
  setFocusedOption,
  onInputModeToggle,
  focusedOption,
  yesInputMode,
  noInputMode,
}: {
  filePath: string
  input: A | undefined
  onChange: (option: PermissionOption, feedback?: string) => void
  options: PermissionOptionWithLabel[]
  ideName: string
  symlinkTarget?: string
  acceptFeedback: string
  rejectFeedback: string
  setFocusedOption: (value: string) => void
  onInputModeToggle: (value: string) => void
  focusedOption: string
  yesInputMode: boolean
  noInputMode: boolean
}): React.ReactNode {
  void input
  const symlinkOutsideCwd =
    symlinkTarget !== undefined &&
    relative(getCwd(), symlinkTarget).startsWith('..')

  const feedbackFor = (option: PermissionOption): string | undefined => {
    if (option.type === 'reject') return rejectFeedback.trim() || undefined
    if (option.type === 'accept-once') return acceptFeedback.trim() || undefined
    return undefined
  }

  const amendHintVisible =
    (focusedOption === 'accept-once' && !yesInputMode) ||
    (focusedOption === 'reject' && !noInputMode)

  return (
    <Box flexDirection="column">
      <Text>
        The proposed changes were opened in <Text bold>{ideName}</Text>.
      </Text>
      {symlinkTarget !== undefined ? (
        <Text color="warning" wrap="wrap">
          {basename(filePath)} is a symlink to {symlinkTarget}
          {symlinkOutsideCwd
            ? ' — OUTSIDE the working directory; the edit lands there.'
            : '.'}
        </Text>
      ) : null}
      {isSupportedVSCodeTerminal() ? (
        <Text dimColor>Saving the file in the editor continues.</Text>
      ) : null}
      <Text>
        Make this edit to <Text bold>{basename(filePath)}</Text>?
      </Text>
      <Select
        options={options}
        defaultFocusValue={focusedOption}
        onFocus={value => setFocusedOption(value)}
        onChange={value => {
          const chosen = options.find(candidate => candidate.value === value)
          if (!chosen) return
          onChange(chosen.option, feedbackFor(chosen.option))
        }}
        onInputModeToggle={value => onInputModeToggle(value)}
      />
      <Text dimColor italic>
        <KeyboardShortcutHint shortcut="esc" action="cancel" />
        {amendHintVisible ? (
          <>
            {' · '}
            <KeyboardShortcutHint shortcut="tab" action="amend with feedback" />
          </>
        ) : null}
      </Text>
    </Box>
  )
}

export default ShowInIDEPrompt
