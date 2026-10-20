import type { TextBlockParam } from '../../types/wire.js'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { extractTag } from '../../utils/messages.js'
import { TranscriptNameplate, useMessageMeta } from './TranscriptNameplate.js'
import { ShellLiveTail } from '../shell/ShellLiveTail.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

export function UserBashInputMessage({
  param: { text },
  addMargin,
}: Props): React.ReactNode {
  const meta = useMessageMeta()
  const input = extractTag(text, 'bash-input')
  if (!input) {
    return null
  }
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Box flexDirection="row" backgroundColor="bashMessageBackgroundColor" paddingRight={1}>
        <Box flexShrink={0}>
          <TranscriptNameplate />
        </Box>
        <Text color="bashBorder">! </Text>
        <Text color="text">{input}</Text>
      </Box>
      {meta?.uuid && !meta.queued ? <ShellLiveTail inputId={meta.uuid} /> : null}
    </Box>
  )
}
