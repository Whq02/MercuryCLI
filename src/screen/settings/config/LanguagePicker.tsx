import React, { useState } from 'react'
import { Box, Text } from '../../themedRenderer.js'
import TextInput from '../../composer/text-input/TextInput.js'
import { useKeybinding } from '../../keys/useKeybinding.js'
import { useMercuryTokens } from '../../widgets/useMercuryTokens.js'

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
  const initial = initialLanguage ?? ''
  const [value, setValue] = useState(initial)
  const [cursorOffset, setCursorOffset] = useState(initial.length)
  const tokens = useMercuryTokens()

  useKeybinding('confirm:no', onCancel, { context: 'Settings' })

  const handleSubmit = (submitted: string): void => {
    const trimmed = submitted.trim()
    onComplete(trimmed === '' ? undefined : trimmed)
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>Preferred language</Text>
        <Text dimColor>
          Mercury will respond and speak in this language. Leave it empty to use{' '}
          the default.
        </Text>
      </Box>
      <Box>
        <Text color={tokens.info}>{'❯ '}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          columns={FIELD_COLUMNS}
          placeholder="English, 日本語, Español, Deutsch, 中文…"
        />
      </Box>
      <Text dimColor>enter to save · esc to cancel</Text>
    </Box>
  )
}

export default LanguagePicker
