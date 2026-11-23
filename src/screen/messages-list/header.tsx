import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { MercuryBrandRow, MercuryHero, MercuryHome } from '../fullscreen-layout/MercuryHome.js'
import { OffscreenFreeze } from '../messages/OffscreenFreeze.js'
import { StatusNotices } from '../messages/StatusNotices.js'
import type { MessagesProps, VisibleRowsState } from './shapes.js'

export function messagesHeader({ agentDefinitions, columns, hasRealConversation, inCockpit, isCompact, renderRange, suppressLogo, suppressNotices }: { agentDefinitions: MessagesProps['agentDefinitions']; columns: number; hasRealConversation: VisibleRowsState['hasRealConversation']; inCockpit: boolean; isCompact: boolean; renderRange: MessagesProps['renderRange']; suppressLogo: Exclude<MessagesProps['suppressLogo'], undefined>; suppressNotices: Exclude<MessagesProps['suppressNotices'], undefined> }) {
  if (suppressLogo || renderRange) return null
  const notices = suppressNotices ? null : (
    <React.Suspense fallback={null}>
      <StatusNotices agentDefinitions={agentDefinitions} />
    </React.Suspense>
  )
  if (isCompact) return notices
  return (
    <OffscreenFreeze>
      <Box flexDirection="column" width="100%">
        {!inCockpit ? (
          columns >= 96 ? (
            <Box>
              <MercuryHero />
              <Box flexDirection="column" flexGrow={1}>
                {hasRealConversation ? <MercuryBrandRow /> : null}
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column">
              <MercuryHero />
              {hasRealConversation ? <MercuryBrandRow /> : null}
            </Box>
          )
        ) : null}
        {}
        {!hasRealConversation ? <MercuryHome /> : null}
        {}
        {}
        {hasRealConversation && !inCockpit ? (
          <Box>
            <Text dimColor>{'─'.repeat(Math.max(8, Math.min(40, columns - 4)))}</Text>
          </Box>
        ) : null}
        {}
        {notices}
      </Box>
    </OffscreenFreeze>
  )
}
