import React from 'react'
import { Text } from '../themedRenderer.js'
import { colorStripped } from '../renderer/colorize.js'
import type { SystemCrewChatMessage } from '../../engine/message-shapes/message.js'
import { chatNameColor } from '../../crew/board/chat.js'
import { formatClock } from '../../engine/message-shapes/replyAddress.js'
import { stripTerminalControls } from '../../platform/text/strings.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'

function crewChatPlate(message: SystemCrewChatMessage): string {
  return message.captain ? `captain ${message.name}` : message.name
}

export function CrewChatRow({ message }: { message: SystemCrewChatMessage }): React.ReactNode {
  const tokens = useMercuryTokens()
  const name = message.authorRole === 'owner' ? tokens.textPrimary : chatNameColor(message.name, tokens, message.slot)
  const blocker = message.kind === 'blocker'
  const body = blocker ? tokens.failureText : tokens.textSecondary
  return (
    <Text color={tokens.textSecondary} wrap="wrap">
      {formatClock(message.timestamp)} [<Text color={name}>{crewChatPlate(message)}</Text>] <Text color={body} bold={blocker && colorStripped()}>{stripTerminalControls(message.content)}</Text>
    </Text>
  )
}
