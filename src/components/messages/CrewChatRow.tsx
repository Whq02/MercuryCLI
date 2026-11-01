import React from 'react'
import { Text } from '../../ink.js'
import type { SystemCrewChatMessage } from '../../types/message.js'
import { chatNameColor } from '../../services/crewBoard/chat.js'
import { formatClock } from '../../utils/messages/replyAddress.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

export function crewChatPlate(message: SystemCrewChatMessage): string {
  return message.captain ? `captain ${message.name}` : message.name
}

export function CrewChatRow({ message }: { message: SystemCrewChatMessage }): React.ReactNode {
  const tokens = useMercuryTokens()
  const name = message.authorRole === 'owner' ? tokens.textPrimary : chatNameColor(message.team ?? message.name, tokens)
  const body = message.kind === 'blocker' ? tokens.failureText : tokens.textSecondary
  return (
    <Text color={tokens.textSecondary} wrap="wrap">
      {formatClock(message.timestamp)} [<Text color={name}>{crewChatPlate(message)}</Text>] <Text color={body}>{stripTerminalControls(message.content)}</Text>
    </Text>
  )
}
