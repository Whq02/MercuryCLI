// Reverse history search field: a dim label plus a single-line text
// input whose width tracks the query's display width plus one, always
// focused, cursor pinned to the end, rendered dim, one cell of gap. The
// label states whether prompts are being searched or nothing matched.

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
  return (
    <Box gap={1}>
      <Text dimColor>
        {historyFailedMatch ? 'no matching prompt:' : 'search prompts:'}
      </Text>
      <Box width={stringWidth(value) + 1}>
        <TextInput
          value={value}
          onChange={onChange}
          columns={stringWidth(value) + 1}
          cursorOffset={value.length}
          onChangeCursorOffset={() => {}}
          dimColor
          focus
        />
      </Box>
    </Box>
  )
}
