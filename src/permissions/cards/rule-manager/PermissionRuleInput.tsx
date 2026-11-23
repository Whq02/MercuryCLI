import * as React from 'react'
import { exitChordNoticeText } from '../../../screen/composer/ExitChordNotice.js'
import { useState } from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { useKeybinding } from '../../../screen/keys/useKeybinding.js'
import { useExitChordKeys } from '../../../screen/keys/useExitChordKeys.js'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'
import { BASH_TOOL_NAME } from '../../../tools/kit/names/bash.js'
import { WebFetchTool } from '../../../tools/web-fetch/WebFetchTool.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../../rules/permissionRuleParser.js'
import type { PermissionBehavior, PermissionRuleValue } from '../../rules/permissions.js'

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
  const exitState = useExitChordKeys()

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  const handleSubmit = (value: string): void => {
    if (value.trim() === '') return
    onSubmit(permissionRuleValueFromString(value))
  }

  const webFetchExample = permissionRuleValueToString({ toolName: WebFetchTool.name })
  const bashExample = permissionRuleValueToString({
    toolName: BASH_TOOL_NAME,
    ruleContent: 'ls *',
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="permission"
      paddingX={1}
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
      <Text color="subtle">
        {exitState.pending
          ? exitChordNoticeText(exitState.keyName)
          : 'enter submit · esc cancel'}
      </Text>
    </Box>
  )
}
