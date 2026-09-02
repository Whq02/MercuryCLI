// Enable/disable extended thinking for the session. Changing the value
// mid-conversation raises a confirmation first: flipping this part-way
// through costs latency and can cost answer quality, so the surface says so
// and asks before applying.

import React, { useState } from 'react'
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js'
import { Box, Text } from '../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { Select } from './CustomSelect/index.js'
import Byline from './design-system/Byline.js'
import Pane from './design-system/Pane.js'

export type Props = {
  currentValue: boolean
  onSelect: (value: boolean) => void
  onCancel?: () => void
  isMidConversation?: boolean
}

/** Contract data: the two option values. */
const OPTION_VALUES = { enabled: 'true', disabled: 'false' } as const

export function ThinkingToggle({
  currentValue,
  onSelect,
  onCancel,
  isMidConversation = false,
}: Props): React.ReactNode {
  const [pendingValue, setPendingValue] = useState<boolean | null>(null)
  const isConfirming = pendingValue !== null
  const exitState = useExitOnCtrlCDWithKeybindings()
  const cancelKey = useShortcutDisplay('confirm:no', 'Confirmation', 'esc')

  useKeybinding(
    'confirm:yes',
    () => {
      if (pendingValue !== null) onSelect(pendingValue)
    },
    { context: 'Confirmation', isActive: isConfirming },
  )
  useKeybinding(
    'confirm:no',
    () => {
      // Back out of the confirmation first; cancel the surface only when no
      // confirmation is pending.
      if (isConfirming) {
        setPendingValue(null)
        return
      }
      onCancel?.()
    },
    { context: 'Confirmation' },
  )

  const choose = (value: string): void => {
    const next = value === OPTION_VALUES.enabled
    if (isMidConversation && next !== currentValue) {
      setPendingValue(next)
      return
    }
    onSelect(next)
  }

  const current = currentValue ? OPTION_VALUES.enabled : OPTION_VALUES.disabled

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Text bold color="remember">
          Extended thinking
        </Text>
        <Text dimColor>Toggle extended thinking for this session.</Text>
        <Box height={1} />
        {isConfirming ? (
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
            defaultValue={current}
            defaultFocusValue={current}
            visibleOptionCount={2}
            onChange={choose}
            // Always handed to the select, so it always registers as an
            // overlay — a no-op when the caller supplied no cancel.
            onCancel={onCancel ?? ((): void => {})}
          />
        )}
        <Box marginTop={1}>
          {exitState.pending ? (
            <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
          ) : (
            <Text dimColor>
              <Byline>
                <Text dimColor>enter to confirm</Text>
                <Text dimColor>
                  {cancelKey} to {isConfirming ? 'cancel' : 'exit'}
                </Text>
              </Byline>
            </Text>
          )}
        </Box>
      </Box>
    </Pane>
  )
}

export default ThinkingToggle
