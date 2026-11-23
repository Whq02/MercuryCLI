import React from 'react'
import { Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import TextInput from '../TextInput.js'

export default function HistorySearchInput({
  value,
  onChange,
  historyFailedMatch,
}: {
  value: string
  onChange: (value: string) => void
  historyFailedMatch: boolean
}): React.ReactNode {
  const width = stringWidth(value) + 1
  return (
    <Box gap={1}>
      <Text dimColor>
        {historyFailedMatch ? 'no matching prompt:' : 'search prompts:'}
      </Text>
      <Box width={width}>
        <TextInput
          value={value}
          onChange={onChange}
          columns={width}
          cursorOffset={value.length}
          onChangeCursorOffset={() => {}}
          dimColor
          focus
        />
      </Box>
    </Box>
  )
}
