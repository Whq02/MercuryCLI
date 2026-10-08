import React from 'react'
import { Box, Text } from '../../ink.js'
import type { NoticeBlock } from '../../utils/messages/noticeRows.js'
import { isMutedNoticeBlock, noticeCarriesOwnClock, noticePlate } from '../../utils/messages/noticeRows.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { NameplateClock, useMessageMeta } from './TranscriptNameplate.js'

const CLOCK_COLUMN = ' '.repeat(9)

export function UserNoticeMessage({
  addMargin,
  blocks,
  arrivedAt,
  expanded = false,
  fold = false,
  dotColor,
}: {
  addMargin?: boolean
  blocks: NoticeBlock[]
  arrivedAt?: string | null
  expanded?: boolean
  fold?: boolean
  dotColor?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const meta = useMessageMeta()
  return (
    <Box marginTop={addMargin ? 1 : 0} flexDirection="column">
      {blocks.map((block, index) => {
        const clock = index === 0 ? <NameplateClock /> : <Text>{CLOCK_COLUMN}</Text>
        const dot = isMutedNoticeBlock(block) ? null : <Text color={dotColor ?? accent}>● </Text>
        const plate = noticePlate(block, meta?.timestamp)
        const arrival = index === 0 && !noticeCarriesOwnClock(block) && arrivedAt ? ` · arrived ${arrivedAt}` : ''
        const suffix = `${fold ? ` · ${block.lines.length} line${block.lines.length === 1 ? '' : 's'}` : ''}${arrival}${fold && block.lines.length > 0 ? expanded ? ' ⌄' : ' ›' : ''}`
        return (
          <Box key={index} flexDirection="column">
            {fold && !expanded ? (
              <Box flexDirection="row">
                <Box flexShrink={0}><Text>{clock}{dot}</Text></Box>
                <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">{plate}</Text></Box>
                <Box flexShrink={0}>
                  <Text dimColor>{suffix}</Text>
                </Box>
              </Box>
            ) : <Text>{clock}{dot}<Text dimColor>{plate}{suffix}</Text></Text>}
            {(!fold || expanded) && block.lines.map((line, at) => (
              <Text key={at} dimColor wrap="wrap">{'  '}{line}</Text>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

export default UserNoticeMessage
