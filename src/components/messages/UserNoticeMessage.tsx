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
  deliveredAt,
  expanded = false,
  fold = false,
  dotColor,
}: {
  addMargin?: boolean
  blocks: NoticeBlock[]
  arrivedAt?: string | null
  deliveredAt?: string | null
  expanded?: boolean
  fold?: boolean
  dotColor?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const meta = useMessageMeta()
  return (
    <Box marginTop={addMargin ? 1 : 0} flexDirection="column">
      {blocks.map((block, index) => {
        const clock = block.kind === 'outside-report' ? null : index === 0 ? <NameplateClock /> : <Text>{CLOCK_COLUMN}</Text>
        const dot = isMutedNoticeBlock(block) ? null : <Text color={dotColor ?? accent}>● </Text>
        const plate = noticePlate(block, meta?.timestamp)
        const arrival = index === 0 && !noticeCarriesOwnClock(block) && arrivedAt ? ` · arrived ${arrivedAt}` : ''
        const delivery = index === 0 && !noticeCarriesOwnClock(block) && deliveredAt ? ` · delivered ${deliveredAt}` : ''
        const count = block.kind === 'monitor' ? block.count ?? block.lines.length : block.lines.length
        const counted = fold ? ` · ${count} line${count === 1 ? '' : 's'}` : ''
        const last = block.kind === 'monitor' && block.last !== undefined ? ` · last: ${block.last}` : ''
        const tail = `${arrival}${delivery}${fold && block.lines.length > 0 ? expanded ? ' ⌄' : ' ›' : ''}`
        const suffix = `${counted}${last}${tail}`
        return (
          <Box key={index} flexDirection="column">
            {fold && !expanded ? (
              <Box flexDirection="row">
                <Box flexShrink={0}><Text>{clock}{dot}</Text></Box>
                <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">{plate}</Text></Box>
                <Box flexShrink={0}><Text dimColor>{counted}</Text></Box>
                {last !== '' ? (
                  <Box flexShrink={1} minWidth={0}>
                    <Text dimColor wrap="truncate-end">{last}</Text>
                  </Box>
                ) : null}
                <Box flexShrink={0}><Text dimColor>{tail}</Text></Box>
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
