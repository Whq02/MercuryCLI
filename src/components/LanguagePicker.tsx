// Response-language preference: one free-text field (60 columns,
// behind a pointer glyph) seeded from the current value. Submit trims; an
// empty result clears the preference. Escape cancels through the Settings
// keybinding context so typing `n` does not cancel.

import React, { useState } from 'react'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

const FIELD_COLUMNS = 60

export function LanguagePicker({
  initialLanguage,
  onComplete,
  onCancel,
}: {
  initialLanguage: string | undefined
  onComplete: (language: string | undefined) => void
  onCancel: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [value, setValue] = useState(initialLanguage ?? '')
  const [cursorOffset, setCursorOffset] = useState((initialLanguage ?? '').length)

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Preferred language</Text>
      <Text>
        Mercury will respond and speak in this language. Leave it empty to use
        the default.
      </Text>
      <Box>
        <Text color={tokens.info}>❯ </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submitted => {
            const trimmed = submitted.trim()
            onComplete(trimmed === '' ? undefined : trimmed)
          }}
          columns={FIELD_COLUMNS}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          placeholder="English, 日本語, Español, Deutsch, 中文…"
        />
      </Box>
      <Text dimColor>enter to save · esc to cancel</Text>
    </Box>
  )
}

export default LanguagePicker
