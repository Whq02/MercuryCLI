import * as React from 'react'
import { exitChordNoticeText } from '../../PromptInput/ExitChordNotice.js'
import { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import TextInput from '../../TextInput.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import { WebFetchTool } from '../../../tools/WebFetchTool/WebFetchTool.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../../../utils/permissions/permissionRuleParser.js'
import type { PermissionBehavior, PermissionRuleValue } from '../../../types/permissions.js'

type PermissionRuleInputProps = {
  onCancel: () => void
  onSubmit: (ruleValue: PermissionRuleValue) => void
  ruleBehavior: PermissionBehavior
}

export function PermissionRuleInput({
  onCancel,
  onSubmit,
  ruleBehavior,
}: PermissionRuleInputProps): React.ReactNode {
  const [input, setInput] = useState('')
  const { columns } = useTerminalSize()
  const exitState = useExitOnCtrlCDWithKeybindings()

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  const handleSubmit = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed === '') return
    onSubmit(permissionRuleValueFromString(trimmed))
  }

  const webFetchExample = permissionRuleValueToString({ toolName: WebFetchTool.name })
  const bashExample = permissionRuleValueToString({
    toolName: BASH_TOOL_NAME,
    ruleContent: 'ls *',
  })

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="permission"
        paddingX={1}
        gap={1}
      >
        <Text bold color="permission">
          Add {ruleBehavior} permission rule
        </Text>
        <Text dimColor>
          A rule is a tool name, optionally followed by a specifier in
          parentheses — for example{' '}
          <Text bold>{webFetchExample}</Text> or <Text bold>{bashExample}</Text>
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          columns={columns - 6}
          cursorOffset={input.length}
          onChangeCursorOffset={() => {}}
          showCursor
        />
      </Box>
      <Box marginLeft={1}>
        <Text dimColor>
          {exitState.pending
            ? exitChordNoticeText(exitState.keyName)
            : 'enter submit · esc cancel'}
        </Text>
      </Box>
    </Box>
  )
}
