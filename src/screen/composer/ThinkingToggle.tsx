import React, { useState } from 'react'
import { exitChordNoticeText } from './ExitChordNotice.js'
import { Box, Text } from '../themedRenderer.js'
import { useExitChordKeys } from '../keys/useExitChordKeys.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { Select } from '../select/index.js'
import Byline from '../theme/Byline.js'
import Pane from '../theme/Pane.js'

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
  const exitState = useExitChordKeys()
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
      if (pendingValue !== null) {
        setPendingValue(null)
        return
      }
      onCancel?.()
    },
    { context: 'Confirmation' },
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
    <Pane color="permission">
      <Box flexDirection="column">
        <Text bold color="remember">
          Extended thinking
        </Text>
        <Text dimColor>Toggle extended thinking for this session.</Text>
        <Box height={1} />
        {pendingValue !== null ? (
          <Box flexDirection="column">
            <Text color="warning">
              Changing extended thinking mid-conversation adds latency and can
              reduce answer quality — the start of a session is the moment to
              set it.
            </Text>
            <Text color="warning">Proceed with the change?</Text>
          </Box>
        ) : (
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
            visibleOptionCount={2}
            onChange={handleSelect}
            onCancel={onCancel ?? (() => {})}
          />
        )}
        <Box marginTop={1}>
          {exitState.pending ? (
            <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
          ) : (
            <Text dimColor>
              <Byline>
                <Text dimColor>enter to confirm</Text>
                <Text dimColor>{`${cancelKey} to ${pendingValue !== null ? 'cancel' : 'exit'}`}</Text>
              </Byline>
            </Text>
          )}
        </Box>
      </Box>
    </Pane>
  )
}
