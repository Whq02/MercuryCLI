import React, { useState } from 'react'
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js'
import { Box, Text } from '../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { Select } from './CustomSelect/index.js'
import Byline from './design-system/Byline.js'
import Pane from './design-system/Pane.js'

type Props = {
  currentValue: boolean
  isMidConversation?: boolean
  onSelect: (enabled: boolean) => void
  onCancel?: () => void
}

const OPTION_VALUES = { enabled: 'true', disabled: 'false' } as const

export function ThinkingToggle({
  currentValue,
  isMidConversation = false,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const [pendingValue, setPendingValue] = useState<boolean | null>(null)
  const exitState = useExitOnCtrlCDWithKeybindings()
  const cancelKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')

  useKeybinding(
    'confirm:yes',
    () => {
      if (pendingValue !== null) {
        onSelect(pendingValue)
      }
    },
    { context: 'Confirmation', isActive: pendingValue !== null },
  )

  useKeybinding(
    'confirm:no',
    () => {
      setPendingValue(null)
    },
    { context: 'Confirmation', isActive: pendingValue !== null },
  )

  const initialValue = currentValue ? OPTION_VALUES.enabled : OPTION_VALUES.disabled

  const handleSelect = (value: string): void => {
    const nextValue = value === OPTION_VALUES.enabled
    if (isMidConversation && nextValue !== currentValue) {
      setPendingValue(nextValue)
      return
    }
    onSelect(nextValue)
  }

  return (
    <Box flexDirection="column">
      <Pane>
        <Box flexDirection="column">
          <Text bold>Extended thinking</Text>
          <Text dimColor>Toggle extended thinking for this session.</Text>
          {pendingValue !== null ? (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text color="warning">
                Changing extended thinking mid-conversation adds latency and can reduce answer quality — the start of a session is the moment to set it.
              </Text>
              <Text>Proceed with the change?</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Select
                options={[
                  {
                    label: 'Enabled',
                    value: OPTION_VALUES.enabled,
                    description: 'Think before responding',
                  },
                  {
                    label: 'Disabled',
                    value: OPTION_VALUES.disabled,
                    description: 'Respond without extended thinking',
                  },
                ]}
                defaultValue={initialValue}
                defaultFocusValue={initialValue}
                onChange={handleSelect}
                onCancel={onCancel}
              />
            </Box>
          )}
        </Box>
      </Pane>
      <Box marginTop={1} paddingLeft={1}>
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : (
          <Text dimColor>
            <Byline>
              <Text>enter to confirm</Text>
              <Text>{`${cancelKey} to ${pendingValue !== null ? 'cancel' : 'exit'}`}</Text>
            </Byline>
          </Text>
        )}
      </Box>
    </Box>
  )
}

export default ThinkingToggle
