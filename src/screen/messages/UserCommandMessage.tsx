
import figures from 'figures'
import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { TextBlockParam } from '../../engine/message-shapes/wire.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
} from '../../engine/message-shapes/messageTags.js'
import { extractTag } from '../../engine/messages/messages.js'

export function UserCommandMessage({
  addMargin,
  param,
}: {
  addMargin: boolean
  param: TextBlockParam
}): React.ReactNode {
  const commandName = extractTag(param.text, COMMAND_MESSAGE_TAG)
  if (!commandName) return null
  const args = extractTag(param.text, COMMAND_ARGS_TAG) ?? ''
  const isSkill = extractTag(param.text, 'skill-format') === 'true'

  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text backgroundColor="userMessageBackground">
        <Text color="suggestion">{figures.pointer} </Text>
        {isSkill ? (
          <Text>
            Skill <Text bold>{commandName}</Text>
            {args ? <Text dimColor> {args}</Text> : null}
          </Text>
        ) : (
          <Text>
            /{commandName}
            {args ? ` ${args}` : ''}
          </Text>
        )}
      </Text>
    </Box>
  )
}

export default UserCommandMessage
