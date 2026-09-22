import React from 'react'
import { Box, Text } from '../../ink.js'
import type { NoticeBlock } from '../../utils/messages/noticeRows.js'
import { noticePlate } from '../../utils/messages/noticeRows.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { NameplateClock } from './TranscriptNameplate.js'

const CLOCK_COLUMN = ' '.repeat(9)

export function UserNoticeMessage({
  addMargin,
  blocks,
}: {
  addMargin?: boolean
  blocks: NoticeBlock[]
}): React.ReactNode {
  const { accent } = useSessionAccent()
  return (
    <Box marginTop={addMargin ? 1 : 0} flexDirection="column">
      {blocks.map((block, index) => (
        <Box key={index} flexDirection="column">
          <Text>
            {index === 0 ? <NameplateClock /> : <Text>{CLOCK_COLUMN}</Text>}
            <Text color={accent}>● </Text>
            <Text dimColor>{noticePlate(block)}</Text>
          </Text>
          {block.lines.map((line, at) => (
            <Text key={at} dimColor wrap="wrap">
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export default UserNoticeMessage
