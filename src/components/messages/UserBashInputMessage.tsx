import type { TextBlockParam } from '../../types/wire.js'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { extractTag } from '../../utils/messages.js'
import { TranscriptNameplate } from './TranscriptNameplate.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

export function UserBashInputMessage({
  param: { text },
  addMargin,
}: Props): React.ReactNode {
  const input = extractTag(text, 'bash-input')
  if (!input) {
    return null
  }
  return (
    <Box
      flexDirection="row"
      marginTop={addMargin ? 1 : 0}
      backgroundColor="bashMessageBackgroundColor"
      paddingRight={1}
    >
      <Box flexShrink={0}>
          <TranscriptNameplate />
        </Box>
      <Text color="bashBorder">! </Text>
      <Text color="text">{input}</Text>
    </Box>
  )
}
